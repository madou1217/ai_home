// Package upstreamrules 把账号级规则与映射组拼装成 Go 实际求值的有效规则。
//
// 职责边界：
//   - 账号级配置（自身规则 + 挂载组顺序）落 aih.db，由账号级接口读写；
//   - 映射组由 application/upstreammapping 维护，本包只按挂载顺序展开。
//
// 拼装顺序与 Node 的 readEffectiveUpstreamErrorRules 完全一致：组规则按挂载顺序
// 在前，账号自身规则在后；组内规则保持组内顺序。停用组、Provider 不匹配的组、
// 已删除的组都跳过，而不是让整次求值失败——这与 Node 的容错口径一致。
package upstreamrules

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// rulesReadTimeout 限制一次规则读取；求值路径没有请求上下文，必须有界。
	rulesReadTimeout = 2 * time.Second
)

// GroupSource 是拼装所需的映射组读取端口（由 application/upstreammapping 实现）。
type GroupSource interface {
	List(ctx context.Context) ([]mappingcore.Group, error)
}

// Options 声明服务依赖与能力边界。
type Options struct {
	Repository Repository
	Groups     GroupSource
	// SupportedProviders 是 Go 已接入规则求值的 Provider 集合；空集合表示不承接任何账号。
	SupportedProviders []string
}

// Service 是账号规则与有效规则拼装的应用服务。
type Service struct {
	repository Repository
	groups     GroupSource
	supported  map[string]struct{}
	generation atomic.Int64
}

// AccountInput 是账号级配置的全量输入。
type AccountInput struct {
	GroupIDs []string
	Rules    []rulescore.Rule
}

// AccountView 是单个账号的配置与拼装结果。
type AccountView struct {
	AccountRef     string
	Provider       string
	Source         Source
	GroupIDs       []string
	Rules          []rulescore.Rule
	EffectiveRules []rulescore.Rule
	Supported      bool
}

// NewService 创建账号规则服务。
func NewService(options Options) (*Service, error) {
	if options.Repository == nil {
		return nil, ErrServiceUnavailable
	}
	supported := make(map[string]struct{}, len(options.SupportedProviders))
	for _, provider := range options.SupportedProviders {
		normalized := normalizeProvider(provider)
		if normalized == "" {
			return nil, ErrServiceUnavailable
		}
		supported[normalized] = struct{}{}
	}
	return &Service{
		repository: options.Repository,
		groups:     options.Groups,
		supported:  supported,
	}, nil
}

// Generation 返回写入代次，供推送方确认是否已应用。
func (service *Service) Generation() int64 {
	if service == nil {
		return 0
	}
	return service.generation.Load()
}

// SupportedProviders 返回 Go 已接入规则求值的 Provider 集合（已排序）。
func (service *Service) SupportedProviders() []string {
	if service == nil {
		return nil
	}
	providers := make([]string, 0, len(service.supported))
	for provider := range service.supported {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	return providers
}

// RulesFor 返回账号的有效规则；账号不存在、Provider 未接入或没有任何配置时返回 false。
//
// 求值发生在上游失败路径上，没有请求上下文：这里用有界后台上下文读取数据库。
// 读失败按「不承接」处理（fail closed），Node 会继续自己执行规则。
func (service *Service) RulesFor(accountRef string) ([]rulescore.Rule, bool) {
	if service == nil || service.repository == nil {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), rulesReadTimeout)
	defer cancel()
	view, err := service.Effective(ctx, accountRef)
	if err != nil || !view.Supported || view.Source == "" {
		return nil, false
	}
	return view.EffectiveRules, true
}

// Effective 返回账号当前配置与拼装后的有效规则。
func (service *Service) Effective(ctx context.Context, accountRef string) (AccountView, error) {
	if service == nil || service.repository == nil {
		return AccountView{}, ErrServiceUnavailable
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return AccountView{}, ErrInvalidAccountRef
	}
	provider, ok, err := service.repository.AccountProvider(ctx, ref)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取账号 Provider 失败: %w", err)
	}
	if !ok {
		return AccountView{}, ErrAccountNotFound
	}
	provider = normalizeProvider(provider)
	view := AccountView{
		AccountRef:     ref,
		Provider:       provider,
		Supported:      service.supports(provider),
		GroupIDs:       []string{},
		Rules:          []rulescore.Rule{},
		EffectiveRules: []rulescore.Rule{},
	}
	record, exists, err := service.repository.Load(ctx, ref)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取账号级规则失败: %w", err)
	}
	if !exists {
		return view, nil
	}
	effective, err := service.assemble(ctx, record)
	if err != nil {
		return AccountView{}, err
	}
	view.Source = SourceAccount
	view.GroupIDs = append([]string(nil), record.GroupIDs...)
	view.Rules = append([]rulescore.Rule(nil), record.Rules...)
	view.EffectiveRules = effective
	return view, nil
}

// ReplaceAccount 整体替换账号级配置，并返回拼装后的有效规则。
func (service *Service) ReplaceAccount(
	ctx context.Context,
	accountRef string,
	input AccountInput,
) (AccountView, error) {
	if service == nil || service.repository == nil {
		return AccountView{}, ErrServiceUnavailable
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return AccountView{}, ErrInvalidAccountRef
	}
	provider, ok, err := service.repository.AccountProvider(ctx, ref)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取账号 Provider 失败: %w", err)
	}
	if !ok {
		return AccountView{}, ErrAccountNotFound
	}
	provider = normalizeProvider(provider)
	groupIDs, err := normalizeGroupIDs(input.GroupIDs)
	if err != nil {
		return AccountView{}, err
	}
	rules, err := rulescore.Validate(input.Rules)
	if err != nil {
		return AccountView{}, fmt.Errorf("%w: %v", rulescore.ErrInvalidRules, err)
	}
	record := Record{
		AccountRef: ref,
		Provider:   provider,
		GroupIDs:   groupIDs,
		Rules:      rules,
	}
	if err := service.repository.ReplaceAccount(ctx, record); err != nil {
		return AccountView{}, err
	}
	service.generation.Add(1)
	// 回读而不是复用入参：写入空配置时库里没有记录，视图必须如实反映「没有配置」，
	// 否则 PUT 的响应会与紧接着的 GET 不一致。
	return service.Effective(ctx, ref)
}

// DeleteAccount 清空账号级配置；幂等。
func (service *Service) DeleteAccount(ctx context.Context, accountRef string) (bool, error) {
	if service == nil || service.repository == nil {
		return false, ErrServiceUnavailable
	}
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return false, ErrInvalidAccountRef
	}
	deleted, err := service.repository.DeleteAccountRules(ctx, ref)
	if err != nil {
		return false, err
	}
	if deleted {
		service.generation.Add(1)
	}
	return deleted, nil
}

// ListAccounts 返回所有持有账号级配置的账号视图（对账与诊断用）。
func (service *Service) ListAccounts(ctx context.Context) ([]AccountView, error) {
	if service == nil || service.repository == nil {
		return nil, ErrServiceUnavailable
	}
	refs, err := service.repository.ListAccountRefs(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取账号规则索引失败: %w", err)
	}
	views := make([]AccountView, 0, len(refs))
	for _, ref := range refs {
		view, effectiveErr := service.Effective(ctx, ref)
		if errors.Is(effectiveErr, ErrAccountNotFound) {
			// 账号被删除后外键会级联清理；读到瞬时缺失直接跳过。
			continue
		}
		if effectiveErr != nil {
			return nil, effectiveErr
		}
		views = append(views, view)
	}
	return views, nil
}

// assemble 按「挂载组顺序 → 账号规则」拼装账号级记录。
func (service *Service) assemble(ctx context.Context, record Record) ([]rulescore.Rule, error) {
	groups, err := service.groupIndex(ctx)
	if err != nil {
		return nil, err
	}
	return assembleWith(groups, record), nil
}

// groupIndex 一次读取全部映射组，避免逐组查询。
func (service *Service) groupIndex(ctx context.Context) (map[string]mappingcore.Group, error) {
	index := map[string]mappingcore.Group{}
	if service == nil || service.groups == nil {
		return index, nil
	}
	groups, err := service.groups.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取映射组失败: %w", err)
	}
	for _, group := range groups {
		index[group.ID()] = group
	}
	return index, nil
}

// assembleWith 是纯函数拼装：组在前、账号在后，组内与账号内顺序不变。
func assembleWith(groups map[string]mappingcore.Group, record Record) []rulescore.Rule {
	rules := make([]rulescore.Rule, 0, len(record.Rules))
	for _, id := range record.GroupIDs {
		group, ok := groups[id]
		if !ok || !group.Enabled() {
			continue
		}
		if group.Provider() != mappingcore.ScopeAll && group.Provider() != record.Provider {
			continue
		}
		rules = append(rules, group.Rules()...)
	}
	rules = append(rules, record.Rules...)
	return rules
}

// normalizeGroupIDs 去重并校验挂载顺序。
func normalizeGroupIDs(ids []string) ([]string, error) {
	if len(ids) > MaxGroupIDs {
		return nil, fmt.Errorf("%w: 挂载组最多 %d 个", ErrInvalidGroupIDs, MaxGroupIDs)
	}
	seen := make(map[string]struct{}, len(ids))
	normalized := make([]string, 0, len(ids))
	for _, id := range ids {
		parsed, err := mappingcore.ParseID(id)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidGroupIDs, err)
		}
		if _, exists := seen[parsed]; exists {
			continue
		}
		seen[parsed] = struct{}{}
		normalized = append(normalized, parsed)
	}
	return normalized, nil
}

// normalizeProvider 统一 Provider 标识写法。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// supports 判断 Go 是否承接该 Provider 的规则求值。
func (service *Service) supports(provider string) bool {
	if service == nil {
		return false
	}
	_, ok := service.supported[normalizeProvider(provider)]
	return ok
}

// IsAccountNotFound 判断错误是否为账号不存在。
func IsAccountNotFound(err error) bool {
	return errors.Is(err, ErrAccountNotFound)
}
