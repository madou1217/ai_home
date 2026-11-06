// Package upstreammapping 是「上游错误映射组」的纯领域模型。
//
// 映射组是一组命名的上游错误规则：组本身只声明作用范围（provider / enabled）与
// 展示信息，规则正文复用 core/upstreamrules 的值对象。本包只做校验与归一化，
// 不依赖数据库、HTTP 或 Provider 注册表——「Provider 是否已注册」属于运行环境
// 事实，由应用层用注册表判定。
package upstreammapping

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

const (
	// MaxGroups 是映射组总数上限（与 Node 的 MAX_GROUPS 一致）。
	MaxGroups = 100
	// MaxRulesPerGroup 是单个映射组的规则条数上限（与 Node validateUpstreamErrorRules 一致）。
	MaxRulesPerGroup = rulescore.MaxRules
	// MaxNameLength 是映射组名称上限（与 Node normalizeText(name, 80) 一致）。
	MaxNameLength = 80
	// MaxDescriptionLength 是映射组描述上限（与 Node normalizeText(description, 240) 一致）。
	MaxDescriptionLength = 240
	// MaxIDLength 是映射组 id 上限。
	MaxIDLength = 64
	// ScopeAll 表示映射组对所有 Provider 生效（与 Node 的 provider="all" 一致）。
	ScopeAll = "all"
)

var (
	// ErrInvalidGroup 表示映射组不满足领域约束。
	ErrInvalidGroup = errors.New("上游错误映射组无效")
	// ErrGroupNotFound 表示按 id 找不到映射组。
	ErrGroupNotFound = errors.New("上游错误映射组不存在")
	// ErrGroupConflict 表示乐观锁版本已过期（并发修改）。
	ErrGroupConflict = errors.New("上游错误映射组已被并发修改")
	// ErrGroupExists 表示同一 id 已存在且内容不同。
	ErrGroupExists = errors.New("上游错误映射组已存在")
	// ErrGroupLimit 表示映射组数量超过上限。
	ErrGroupLimit = errors.New("上游错误映射组数量超出上限")
	// ErrUnknownProvider 表示目标 Provider 不在当前注册表里。
	ErrUnknownProvider = errors.New("上游错误映射组的目标 Provider 无效")
)

// idPattern 与 Node normalizeId 的正则一致。
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// providerPattern 限定归一化后的 Provider 标识形状；成员资格由应用层另行判定。
var providerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// invalid 构造统一的映射组校验错误。
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidGroup, fmt.Sprintf(format, args...))
}

// ParseID 校验并返回映射组 id。
func ParseID(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if !idPattern.MatchString(trimmed) {
		return "", invalid("映射组 id 须为 1–%d 位字母、数字、下划线或短横线", MaxIDLength)
	}
	return trimmed, nil
}

// Entry 是组内的一条规则及其匹配顺序。
//
// Position 是组内唯一的匹配次序：Node 按规则数组顺序逐条尝试，Go 把它显式化，
// 才能在关系表里保持同一语义。顺序从 0 开始连续递增。
type Entry struct {
	Position int
	Rule     rulescore.Rule
}

// EntriesFromRules 按数组下标生成条目顺序，供创建请求使用。
func EntriesFromRules(rules []rulescore.Rule) []Entry {
	entries := make([]Entry, 0, len(rules))
	for index, rule := range rules {
		entries = append(entries, Entry{Position: index, Rule: rule})
	}
	return entries
}

// Group 是一个已归一化的映射组值对象。
//
// 字段全部私有：组只能由 NewGroup（创建）或 RestoreGroup（从持久化恢复）产生，
// 避免调用点绕过校验直接拼装一个半合法的组。
type Group struct {
	id          string
	name        string
	description string
	provider    string
	enabled     bool
	position    int
	version     int64
	entries     []Entry
	createdAt   time.Time
	updatedAt   time.Time
}

// Input 是构造映射组的输入；创建时只需要内容字段，元数据由存储层分配。
type Input struct {
	ID          string
	Name        string
	Description string
	Provider    string
	Enabled     *bool
	Entries     []Entry
	Position    int
	Version     int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// NewGroup 校验并按 Node normalizeGroup 的语义归一化一个新组。
//
// 只校验内容，不要求 position/version/时间：这些都是持久化元数据，由存储层在
// 事务里分配，调用方无法伪造「版本比实际更新」。
func NewGroup(input Input) (Group, error) {
	return buildGroup(input, false)
}

// RestoreGroup 从持久化记录恢复映射组，并校验元数据不变量。
//
// 恢复路径必须再校验一次：数据库可能被外部工具改过，读出一个顺序错乱或版本为 0
// 的组，比直接报结构不兼容更危险。
func RestoreGroup(input Input) (Group, error) {
	return buildGroup(input, true)
}

// buildGroup 是创建与恢复共用的构造路径。
func buildGroup(input Input, restore bool) (Group, error) {
	id, err := ParseID(input.ID)
	if err != nil {
		return Group{}, err
	}
	name := truncateText(input.Name, MaxNameLength)
	if name == "" {
		return Group{}, invalid("映射组名称不能为空")
	}
	description := truncateText(input.Description, MaxDescriptionLength)
	provider, err := normalizeProvider(input.Provider)
	if err != nil {
		return Group{}, err
	}
	entries, err := validateEntries(input.Entries)
	if err != nil {
		return Group{}, err
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	group := Group{
		id:          id,
		name:        name,
		description: description,
		provider:    provider,
		enabled:     enabled,
		position:    input.Position,
		version:     input.Version,
		entries:     entries,
		createdAt:   input.CreatedAt.UTC(),
		updatedAt:   input.UpdatedAt.UTC(),
	}
	if !restore {
		return group, nil
	}
	if group.position < 0 {
		return Group{}, invalid("映射组顺序不能为负数")
	}
	if group.version < 1 {
		return Group{}, invalid("映射组版本必须从 1 开始")
	}
	if group.createdAt.IsZero() || group.updatedAt.IsZero() {
		return Group{}, invalid("映射组时间戳缺失")
	}
	if group.updatedAt.Before(group.createdAt) {
		return Group{}, invalid("映射组更新时间早于创建时间")
	}
	return group, nil
}

// validateEntries 校验组内规则的条数与顺序，并逐条重新编译。
//
// 顺序要求「唯一且连续」：Node 的匹配语义是数组顺序，出现重复或空洞时无法判断
// 哪条优先，属于持久化损坏而不是可修复的配置。
func validateEntries(entries []Entry) ([]Entry, error) {
	if len(entries) == 0 || len(entries) > MaxRulesPerGroup {
		return nil, invalid("每个映射组须有 1–%d 条规则", MaxRulesPerGroup)
	}
	validated := make([]Entry, 0, len(entries))
	for index, entry := range entries {
		if entry.Position != index {
			return nil, invalid("规则顺序必须唯一且连续")
		}
		rule, err := validateRule(entry.Rule)
		if err != nil {
			return nil, err
		}
		validated = append(validated, Entry{Position: entry.Position, Rule: rule})
	}
	return validated, nil
}

// validateRule 按 Node 口径重新校验并编译一条规则。
//
// 必须用 NewRule（而不是直接信任 Rule 的 JSON 解码）：解码只为兼容投影放宽了
// 正则编译，写入口要保证「落库的每条正则当前就能执行」。
func validateRule(rule rulescore.Rule) (rulescore.Rule, error) {
	for _, matcher := range rule.Matchers() {
		pattern := ""
		switch {
		case matcher.IsLegacy():
			pattern = matcher.Pattern()
		case matcher.Operator() == rulescore.OperatorRegex:
			pattern = rulescore.TextOf(matcher.Value())
		default:
			continue
		}
		if err := validatePattern(pattern); err != nil {
			return rulescore.Rule{}, err
		}
	}
	compiled, err := rulescore.NewRule(
		rule.Name(),
		rule.Kind(),
		rule.Enabled(),
		rule.Statuses(),
		rule.Matchers(),
	)
	if err != nil {
		return rulescore.Rule{}, fmt.Errorf("%w: %v", ErrInvalidGroup, err)
	}
	return compiled, nil
}

// normalizeProvider 归一化目标 Provider（与 Node 的小写 + 默认 all 一致）。
func normalizeProvider(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ScopeAll, nil
	}
	if !providerPattern.MatchString(normalized) {
		return "", invalid("目标 Provider 格式无效")
	}
	return normalized, nil
}

// truncateText 去空白后按字符数截断；与 Node normalizeText 的截断语义一致。
func truncateText(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	runes := []rune(trimmed)
	if len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

// ID 返回映射组 id。
func (group Group) ID() string { return group.id }

// Name 返回映射组名称。
func (group Group) Name() string { return group.name }

// Description 返回映射组描述。
func (group Group) Description() string { return group.description }

// Provider 返回归一化后的目标 Provider。
func (group Group) Provider() string { return group.provider }

// Enabled 返回映射组是否生效。
func (group Group) Enabled() bool { return group.enabled }

// Position 返回映射组在集合里的稳定顺序。
func (group Group) Position() int { return group.position }

// Version 返回乐观锁版本，首次写入为 1。
func (group Group) Version() int64 { return group.version }

// CreatedAt 返回创建时间。
func (group Group) CreatedAt() time.Time { return group.createdAt }

// UpdatedAt 返回最近更新时间。
func (group Group) UpdatedAt() time.Time { return group.updatedAt }

// Entries 返回组内规则的防御性副本（含顺序）。
func (group Group) Entries() []Entry {
	entries := make([]Entry, len(group.entries))
	copy(entries, group.entries)
	return entries
}

// Rules 返回按顺序排列的规则副本，供匹配直接使用。
func (group Group) Rules() []rulescore.Rule {
	rules := make([]rulescore.Rule, 0, len(group.entries))
	for _, entry := range group.entries {
		rules = append(rules, entry.Rule)
	}
	return rules
}

// SameContent 判断两个组的内容是否一致（忽略 id 与持久化元数据）。
//
// 用于 POST 的幂等重试：同一个 id 用同样内容再提交一次应返回原记录，而不是报冲突。
func (group Group) SameContent(other Group) bool {
	if group.name != other.name ||
		group.description != other.description ||
		group.provider != other.provider ||
		group.enabled != other.enabled {
		return false
	}
	left, leftErr := json.Marshal(group.Rules())
	right, rightErr := json.Marshal(other.Rules())
	return leftErr == nil && rightErr == nil && bytes.Equal(left, right)
}

// MarshalJSON 输出与 Node 映射组同形的对象，并附带 Go 的版本与顺序元数据。
func (group Group) MarshalJSON() ([]byte, error) {
	rules := group.Rules()
	if rules == nil {
		rules = []rulescore.Rule{}
	}
	return json.Marshal(struct {
		ID          string           `json:"id"`
		Name        string           `json:"name"`
		Description string           `json:"description"`
		Provider    string           `json:"provider"`
		Enabled     bool             `json:"enabled"`
		Position    int              `json:"position"`
		Version     int64            `json:"version"`
		Rules       []rulescore.Rule `json:"rules"`
		CreatedAtMS int64            `json:"createdAtMs"`
		UpdatedAtMS int64            `json:"updatedAtMs"`
	}{
		ID:          group.id,
		Name:        group.name,
		Description: group.description,
		Provider:    group.provider,
		Enabled:     group.enabled,
		Position:    group.position,
		Version:     group.version,
		Rules:       rules,
		CreatedAtMS: group.createdAt.UnixMilli(),
		UpdatedAtMS: group.updatedAt.UnixMilli(),
	})
}
