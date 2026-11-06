// Package upstreammapping 是上游错误映射组的应用层用例。
//
// 它把「目标 Provider 是否已注册」这一运行环境事实与纯领域校验组合起来，并对
// 存储端口暴露创建 / 更新 / 删除 / 查询四个用例。HTTP 与 SQLite 都不在这里出现。
package upstreammapping

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// ErrServiceUnavailable 表示服务缺少存储端口。
var ErrServiceUnavailable = errors.New("上游错误映射组服务不可用")

// Service 是映射组的写用例。
type Service struct {
	repository Repository
	providers  map[string]struct{}
}

// NewService 创建映射组用例；providerIDs 是当前已注册的 Provider 标识。
//
// 空集合时只有 all 合法：宁可拒绝一个暂时没注册的 Provider，也不要存下一个
// 永远不会命中的组——用户会以为规则已生效。
func NewService(repository Repository, providerIDs []string) (*Service, error) {
	if repository == nil {
		return nil, ErrServiceUnavailable
	}
	providers := make(map[string]struct{}, len(providerIDs)+1)
	providers[mappingcore.ScopeAll] = struct{}{}
	for _, id := range providerIDs {
		if normalized := strings.ToLower(strings.TrimSpace(id)); normalized != "" {
			providers[normalized] = struct{}{}
		}
	}
	return &Service{repository: repository, providers: providers}, nil
}

// CreateInput 是新建映射组的输入；ID 为空时由服务生成。
type CreateInput struct {
	ID          string
	Name        string
	Description string
	Provider    string
	Enabled     *bool
	Rules       []rulescore.Rule
}

// UpdateInput 是更新映射组的输入；nil 字段表示沿用当前值（与 Node 的合并语义一致）。
type UpdateInput struct {
	Name        *string
	Description *string
	Provider    *string
	Enabled     *bool
	Rules       *[]rulescore.Rule
	// Version 是客户端读到的版本；提供时先做一次快速冲突判定，最终仍由存储 CAS 兜底。
	Version *int64
}

// List 返回全部映射组。
func (service *Service) List(ctx context.Context) ([]mappingcore.Group, error) {
	if service == nil || service.repository == nil {
		return nil, ErrServiceUnavailable
	}
	return service.repository.List(ctx)
}

// Get 返回单个映射组。
func (service *Service) Get(ctx context.Context, id string) (mappingcore.Group, error) {
	if service == nil || service.repository == nil {
		return mappingcore.Group{}, ErrServiceUnavailable
	}
	parsed, err := mappingcore.ParseID(id)
	if err != nil {
		return mappingcore.Group{}, err
	}
	return service.repository.Get(ctx, parsed)
}

// Create 新建映射组；同 id 同内容重复提交按幂等处理。
func (service *Service) Create(ctx context.Context, input CreateInput) (mappingcore.Group, error) {
	if service == nil || service.repository == nil {
		return mappingcore.Group{}, ErrServiceUnavailable
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		generated, err := generateID()
		if err != nil {
			return mappingcore.Group{}, err
		}
		id = generated
	}
	group, err := mappingcore.NewGroup(mappingcore.Input{
		ID:          id,
		Name:        input.Name,
		Description: input.Description,
		Provider:    input.Provider,
		Enabled:     input.Enabled,
		Entries:     mappingcore.EntriesFromRules(input.Rules),
	})
	if err != nil {
		return mappingcore.Group{}, err
	}
	if err := service.assertProvider(group.Provider()); err != nil {
		return mappingcore.Group{}, err
	}
	// 幂等重试：客户端带同一个 id 再提交一次，内容一致就返回原记录，不推进版本。
	if existing, err := service.repository.Get(ctx, group.ID()); err == nil {
		if existing.SameContent(group) {
			return existing, nil
		}
		return mappingcore.Group{}, mappingcore.ErrGroupExists
	} else if !errors.Is(err, mappingcore.ErrGroupNotFound) {
		return mappingcore.Group{}, err
	}
	created, err := service.repository.Create(ctx, group)
	if errors.Is(err, mappingcore.ErrGroupExists) {
		// 与其它写入者竞争同一个 id：再读一次，仍可能是幂等重试。
		if existing, getErr := service.repository.Get(ctx, group.ID()); getErr == nil && existing.SameContent(group) {
			return existing, nil
		}
	}
	return created, err
}

// Update 修改映射组；未提供的字段沿用当前值。
func (service *Service) Update(
	ctx context.Context,
	id string,
	input UpdateInput,
) (mappingcore.Group, error) {
	if service == nil || service.repository == nil {
		return mappingcore.Group{}, ErrServiceUnavailable
	}
	parsed, err := mappingcore.ParseID(id)
	if err != nil {
		return mappingcore.Group{}, err
	}
	current, err := service.repository.Get(ctx, parsed)
	if err != nil {
		return mappingcore.Group{}, err
	}
	if input.Version != nil && *input.Version != current.Version() {
		return mappingcore.Group{}, mappingcore.ErrGroupConflict
	}
	name := current.Name()
	if input.Name != nil {
		name = *input.Name
	}
	description := current.Description()
	if input.Description != nil {
		description = *input.Description
	}
	provider := current.Provider()
	if input.Provider != nil {
		provider = *input.Provider
	}
	// enabled 必须显式传当前值：NewGroup 对 nil 按「启用」处理，直接透传会让
	// 「只改名字」的请求把停用组静默打开。
	enabled := current.Enabled()
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	entries := current.Entries()
	if input.Rules != nil {
		entries = mappingcore.EntriesFromRules(*input.Rules)
	}
	next, err := mappingcore.NewGroup(mappingcore.Input{
		ID:          parsed,
		Name:        name,
		Description: description,
		Provider:    provider,
		Enabled:     &enabled,
		Entries:     entries,
	})
	if err != nil {
		return mappingcore.Group{}, err
	}
	if err := service.assertProvider(next.Provider()); err != nil {
		return mappingcore.Group{}, err
	}
	expected := current.Version()
	if input.Version != nil {
		expected = *input.Version
	}
	return service.repository.Update(ctx, next, expected)
}

// Delete 删除映射组；version 为 nil 时不要求客户端持有版本。
func (service *Service) Delete(ctx context.Context, id string, version *int64) error {
	if service == nil || service.repository == nil {
		return ErrServiceUnavailable
	}
	parsed, err := mappingcore.ParseID(id)
	if err != nil {
		return err
	}
	return service.repository.Delete(ctx, parsed, version)
}

// assertProvider 校验目标 Provider 已在注册表里。
func (service *Service) assertProvider(provider string) error {
	if _, ok := service.providers[provider]; !ok {
		return mappingcore.ErrUnknownProvider
	}
	return nil
}

// generateID 生成 uem_ + 12 位十六进制 id，与 Node 的 crypto.randomBytes(6) 同形。
func generateID() (string, error) {
	var buffer [6]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", fmt.Errorf("生成映射组 id 失败: %w", err)
	}
	return "uem_" + hex.EncodeToString(buffer[:]), nil
}
