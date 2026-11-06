// Package upstreamrules 把账号级规则与映射组拼装成 Go 实际求值的有效规则。
//
// 职责边界：
//   - 账号级配置（自身规则 + 挂载组顺序）落 aih.db，由账号级接口读写；
//   - 映射组由 application/upstreammapping 维护，本包只按挂载顺序展开；
//   - 旧接口 PUT /v1/management/upstream-error-rules 仍接收「已拼装有效规则」，
//     作为兼容投影单独存放，避免双写期与账号级配置互相覆盖。
//
// 拼装顺序与 Node 的 readEffectiveUpstreamErrorRules 完全一致：组规则按挂载顺序
// 在前，账号自身规则在后；组内规则保持组内顺序。停用组、Provider 不匹配的组、
// 已删除的组都跳过，而不是让整次求值失败——这与 Node 的容错口径一致。
package upstreamrules

import (
	"context"
	"encoding/json"
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

	// DropProviderNotSupported 表示 Go 尚未接入该 Provider 的规则求值。
	DropProviderNotSupported = "provider_not_supported"
	// DropInvalidRules 表示规则集合不满足领域约束。
	DropInvalidRules = "invalid_rules"
	// DropUnknownAccountRef 表示账号引用为空、重复或账号不存在。
	DropUnknownAccountRef = "unknown_account_ref"
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

// ProjectionAccount 是兼容投影里的单个账号记录。
type ProjectionAccount struct {
	AccountRef string
	Provider   string
	Rules      []rulescore.Rule
}

// Drop 是一条被丢弃的投影记录及原因。
type Drop struct {
	AccountRef string
	Reason     string
}

// ProjectionResult 是一次兼容投影替换的结果。
type ProjectionResult struct {
	Generation int64
	Accepted   []string
	Dropped    []Drop
	// Mismatched 是「账号级拼装结果」与旧 Node 推来的有效规则不一致的账号。
	//
	// 只在双写期有意义：它让「先双写 → 对拍」有可观测的退出条件，而不是靠人肉抽查。
	Mismatched []string
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
	record, exists, err := service.repository.Load(ctx, ref, SourceAccount)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取账号级规则失败: %w", err)
	}
	if exists {
		effective, assembleErr := service.assemble(ctx, record)
		if assembleErr != nil {
			return AccountView{}, assembleErr
		}
		view.Source = SourceAccount
		view.GroupIDs = append([]string(nil), record.GroupIDs...)
		view.Rules = append([]rulescore.Rule(nil), record.Rules...)
		view.EffectiveRules = effective
		return view, nil
	}
	projection, exists, err := service.repository.Load(ctx, ref, SourceProjection)
	if err != nil {
		return AccountView{}, fmt.Errorf("读取兼容投影失败: %w", err)
	}
	if !exists {
		return view, nil
	}
	view.Source = SourceProjection
	view.Rules = append([]rulescore.Rule(nil), projection.Rules...)
	// 兼容投影是「已拼装有效规则」：走同一个 assemble，但组输入为空，绝不会再展开一次。
	view.EffectiveRules = assembleWith(nil, projection)
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
		Source:     SourceAccount,
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

// DeleteAccount 清空账号级配置与兼容投影；幂等。
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

// ReplaceProjection 整体替换兼容投影，并返回接受结果与双写对拍差异。
//
// 兼容投影是「已经拼装好的有效规则」，因此不会再展开挂载组；写入后该账号的读取
// 仍走同一个 assemble 入口，只是输入退化为「零个组 + 这份规则」。
func (service *Service) ReplaceProjection(
	ctx context.Context,
	accounts []ProjectionAccount,
) (ProjectionResult, error) {
	if service == nil || service.repository == nil {
		return ProjectionResult{}, ErrServiceUnavailable
	}
	if len(accounts) > MaxAccounts {
		return ProjectionResult{}, ErrInvalidProjection
	}
	// 组只在需要与账号级配置对拍时读取：旧 Node 没有账号级记录时，兼容投影
	// 不需要展开任何组，组表读失败也不应让这次推送整体失败。
	var groups map[string]mappingcore.Group
	groupsLoaded := false
	seen := make(map[string]struct{}, len(accounts))
	accepted := make([]Record, 0, len(accounts))
	acceptedRefs := make([]string, 0, len(accounts))
	dropped := make([]Drop, 0)
	mismatched := make([]string, 0)
	for _, account := range accounts {
		ref := strings.TrimSpace(account.AccountRef)
		if ref == "" {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropUnknownAccountRef})
			continue
		}
		if _, exists := seen[ref]; exists {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropUnknownAccountRef})
			continue
		}
		seen[ref] = struct{}{}
		provider, ok, providerErr := service.repository.AccountProvider(ctx, ref)
		if providerErr != nil {
			return ProjectionResult{}, fmt.Errorf("读取账号 Provider 失败: %w", providerErr)
		}
		if !ok {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropUnknownAccountRef})
			continue
		}
		provider = normalizeProvider(provider)
		if !service.supports(provider) {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropProviderNotSupported})
			continue
		}
		rules, validateErr := rulescore.Validate(account.Rules)
		if validateErr != nil {
			dropped = append(dropped, Drop{AccountRef: ref, Reason: DropInvalidRules})
			continue
		}
		record := Record{
			AccountRef: ref,
			Provider:   provider,
			Source:     SourceProjection,
			Rules:      rules,
		}
		// 对拍只对「账号级配置已存在」的账号有意义：否则比较的是旧投影与新投影，
		// 会把一次正常更新误报成拼装差异。
		if accountRecord, exists, loadErr := service.repository.Load(ctx, ref, SourceAccount); loadErr != nil {
			return ProjectionResult{}, fmt.Errorf("读取账号级规则失败: %w", loadErr)
		} else if exists {
			if !groupsLoaded {
				loaded, groupErr := service.groupIndex(ctx)
				if groupErr != nil {
					return ProjectionResult{}, groupErr
				}
				groups = loaded
				groupsLoaded = true
			}
			assembled := assembleWith(groups, accountRecord)
			if !sameRules(assembled, rules) {
				mismatched = append(mismatched, ref)
			}
		}
		accepted = append(accepted, record)
		acceptedRefs = append(acceptedRefs, ref)
	}
	if err := service.repository.ReplaceProjection(ctx, accepted); err != nil {
		return ProjectionResult{}, err
	}
	service.generation.Add(1)
	sort.Strings(acceptedRefs)
	sort.Strings(mismatched)
	return ProjectionResult{
		Generation: service.generation.Load(),
		Accepted:   acceptedRefs,
		Dropped:    dropped,
		Mismatched: mismatched,
	}, nil
}

// ListAccounts 返回所有持有账号级配置或兼容投影的账号视图（对账与诊断用）。
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

// Snapshot 返回兼容投影的全部账号（只读诊断用）。
func (service *Service) Snapshot(ctx context.Context) ([]Record, error) {
	if service == nil || service.repository == nil {
		return nil, ErrServiceUnavailable
	}
	return service.repository.List(ctx, SourceProjection)
}

// assemble 按「挂载组顺序 → 账号规则」拼装账号级记录。
func (service *Service) assemble(ctx context.Context, record Record) ([]rulescore.Rule, error) {
	if record.Source == SourceProjection {
		return append([]rulescore.Rule(nil), record.Rules...), nil
	}
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
	if record.Source == SourceAccount {
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

// sameRules 用规范化 JSON 比较两份规则；规则顺序是匹配语义的一部分，不能排序。
func sameRules(left, right []rulescore.Rule) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return string(leftJSON) == string(rightJSON)
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
