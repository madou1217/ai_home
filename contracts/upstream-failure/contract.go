package upstreamfailure

// 本包是「上游失败语义」的唯一数据源（contracts/upstream-failure/failures.json）。
//
// 为什么要有它：状态码/错误标识到失败语义的映射、以及失败语义到运行态动作的
// 策略，过去是每个 Provider 分类器与 core/accountruntime.PolicyFor 里的 switch。
// 那样每加一条语义（例如 402 视为 permanent、某个 Provider 的 511 单独处理）都要
// 改框架代码。现在两张表都在 JSON 里：加语义 = 加一行 signals；加动作 = 加一行
// policies。Provider 只负责把证据（状态码、结构化 error.type/error.code、
// Retry-After、条件位）投影成 SignalInput。
//
// 本包是叶子包：不依赖 core、internal 或数据库，供 core 与各 Provider 适配器
// 共同读取，避免两侧事实漂移。

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

//go:embed failures.json
var manifest []byte

// ErrInvalidContract 表示失败语义契约不满足领域约束。
var ErrInvalidContract = errors.New("上游失败语义契约无效")

// SourceBuiltin 表示内置契约行；SourceOverride 表示全局覆盖行。
const (
	SourceBuiltin  = "builtin_contract"
	SourceOverride = "global_override"
)

// Policy 是失败语义到运行态动作的唯一策略行。
type Policy struct {
	Kind              string   `json:"kind"`
	Action            string   `json:"action"`
	Threshold         int      `json:"threshold,omitempty"`
	FailureWindowMS   int64    `json:"failure_window_ms,omitempty"`
	DefaultCooldownMS int64    `json:"default_cooldown_ms,omitempty"`
	BlockScopes       []string `json:"block_scopes,omitempty"`
	DefaultBlockScope string   `json:"default_block_scope,omitempty"`
	Recovery          string   `json:"recovery,omitempty"`
}

// Signal 是一条「证据 → 语义」的匹配行。
type Signal struct {
	ID                string   `json:"id"`
	Provider          string   `json:"provider"`
	Priority          int      `json:"priority,omitempty"`
	Statuses          []int    `json:"statuses,omitempty"`
	StatusMin         *int     `json:"status_min,omitempty"`
	StatusMax         *int     `json:"status_max,omitempty"`
	ErrorType         string   `json:"error_type,omitempty"`
	ErrorCode         string   `json:"error_code,omitempty"`
	ErrorTypeOrCode   []string `json:"error_type_or_code,omitempty"`
	RetryAfterOverMS  *int64   `json:"retry_after_over_ms,omitempty"`
	RequireConditions []string `json:"require_conditions,omitempty"`
	Semantic          string   `json:"semantic"`
	BlockScope        string   `json:"block_scope,omitempty"`
	Enabled           *bool    `json:"enabled,omitempty"`

	// Source 由合并层填写，不来自 JSON。
	Source string `json:"source,omitempty"`
	// Shadowed 表示该内置行被全局覆盖禁用。
	Shadowed bool `json:"shadowed,omitempty"`

	layer int
}

// RuleKind 是用户可配置规则 kind 到失败语义的映射行。
type RuleKind struct {
	Kind       string `json:"kind"`
	Semantic   string `json:"semantic"`
	BlockScope string `json:"block_scope,omitempty"`
	// Blocking 为 false 时，即使语义本身是阻塞动作，也只产出非阻塞分类：
	// 凭据类规则依赖 ObservedAttemptRecorder 的异步归属与静态密钥降级，
	// 不能在分类阶段直接写成硬阻塞。
	Blocking *bool `json:"blocking,omitempty"`
}

// Document 是完整契约。
type Document struct {
	SchemaVersion int        `json:"schema_version"`
	Policies      []Policy   `json:"policies"`
	Signals       []Signal   `json:"signals"`
	RuleKinds     []RuleKind `json:"rule_kinds"`

	policyIndex map[string]Policy
	ruleIndex   map[string]RuleKind
	order       []int
	signals     []Signal
}

// SignalInput 是 Provider 适配器投影出的低敏证据。
type SignalInput struct {
	Provider   string
	StatusCode int
	ErrorType  string
	ErrorCode  string
	RetryAfter int64 // 毫秒
	Conditions map[string]bool
}

// Match 是命中的信号及其语义。
type Match struct {
	SignalID   string
	Provider   string
	Semantic   string
	BlockScope string
	Source     string
}

// Override 是运行时可编辑的全局覆盖。
type Override struct {
	Policies map[string]PolicyOverride `json:"policies,omitempty"`
	Signals  []Signal                  `json:"signals,omitempty"`
	Disable  []string                  `json:"disable,omitempty"`
}

// PolicyOverride 只允许覆盖策略参数，不允许改动作边界。
type PolicyOverride struct {
	Threshold         *int   `json:"threshold,omitempty"`
	FailureWindowMS   *int64 `json:"failure_window_ms,omitempty"`
	DefaultCooldownMS *int64 `json:"default_cooldown_ms,omitempty"`
}

var (
	builtin *Document

	effective atomic.Pointer[Document]

	overrideMu       sync.Mutex
	currentOverride  *Override
	effectiveVersion uint64
)

func init() {
	document, err := Parse(manifest)
	if err != nil {
		panic(fmt.Sprintf("上游失败语义契约无效: %v", err))
	}
	builtin = document
	effective.Store(document)
}

// Default 返回内置契约（只读；调用方不得修改切片内容）。
func Default() *Document { return builtin }

// Effective 返回合并全局覆盖后的生效契约（只读）。
func Effective() *Document { return effective.Load() }

// Version 返回生效契约的单调版本号，供需要缓存派生结果的调用方使用。
func Version() uint64 { return atomic.LoadUint64(&effectiveVersion) }

// Parse 解析并校验一份契约文档。
func Parse(raw []byte) (*Document, error) {
	var document Document
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidContract, err)
	}
	if err := document.prepare(); err != nil {
		return nil, err
	}
	return &document, nil
}

// ParseOverride 解析一份全局覆盖配置。
func ParseOverride(raw []byte) (*Override, error) {
	var override Override
	if err := json.Unmarshal(raw, &override); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidContract, err)
	}
	return &override, nil
}

// ConfigureOverrides 原子替换全局覆盖；nil 或空覆盖表示回到内置契约。
func ConfigureOverrides(override *Override) error {
	merged, err := mergeOverride(builtin, override)
	if err != nil {
		return err
	}
	overrideMu.Lock()
	defer overrideMu.Unlock()
	if override == nil {
		currentOverride = nil
	} else {
		clone := *override
		currentOverride = &clone
	}
	effective.Store(merged)
	atomic.AddUint64(&effectiveVersion, 1)
	return nil
}

// Overrides 返回当前全局覆盖的副本。
func Overrides() *Override {
	overrideMu.Lock()
	defer overrideMu.Unlock()
	if currentOverride == nil {
		return nil
	}
	clone := *currentOverride
	clone.Signals = append([]Signal(nil), currentOverride.Signals...)
	clone.Disable = append([]string(nil), currentOverride.Disable...)
	clone.Policies = make(map[string]PolicyOverride, len(currentOverride.Policies))
	for kind, value := range currentOverride.Policies {
		clone.Policies[kind] = value
	}
	return &clone
}

// Policy 返回指定失败语义的策略行。
func (document *Document) Policy(kind string) (Policy, bool) {
	if document == nil {
		return Policy{}, false
	}
	policy, found := document.policyIndex[strings.TrimSpace(kind)]
	return policy, found
}

// RuleKind 返回用户规则 kind 的映射行。
func (document *Document) RuleKind(kind string) (RuleKind, bool) {
	if document == nil {
		return RuleKind{}, false
	}
	entry, found := document.ruleIndex[strings.TrimSpace(kind)]
	return entry, found
}

// Resolve 按生效契约解析一条证据；未命中返回 false。
func Resolve(input SignalInput) (Match, bool) {
	return effective.Load().Resolve(input)
}

// Resolve 按本契约解析一条证据。
//
// 顺序：覆盖行先于内置行；同层内 Provider 精确匹配先于 "all"，再按 priority
// 升序（0 最高），最后按文件顺序。任何一行命中即返回，不做多行合并。
func (document *Document) Resolve(input SignalInput) (Match, bool) {
	if document == nil {
		return Match{}, false
	}
	provider := normalizeToken(input.Provider)
	errorType := normalizeToken(input.ErrorType)
	errorCode := normalizeToken(input.ErrorCode)
	for _, index := range document.order {
		signal := document.signals[index]
		if signal.Enabled != nil && !*signal.Enabled {
			continue
		}
		if !matchesProvider(signal.Provider, provider) {
			continue
		}
		if !matchesStatus(signal, input.StatusCode) {
			continue
		}
		if !matchesError(signal, errorType, errorCode) {
			continue
		}
		if signal.RetryAfterOverMS != nil && input.RetryAfter <= *signal.RetryAfterOverMS {
			continue
		}
		if !matchesConditions(signal.RequireConditions, input.Conditions) {
			continue
		}
		return Match{
			SignalID:   signal.ID,
			Provider:   signal.Provider,
			Semantic:   signal.Semantic,
			BlockScope: signal.BlockScope,
			Source:     signal.Source,
		}, true
	}
	return Match{}, false
}

// prepare 建立索引、校验约束并排序。
func (document *Document) prepare() error {
	if document.SchemaVersion != 1 {
		return fmt.Errorf("%w: schema_version=%d", ErrInvalidContract, document.SchemaVersion)
	}
	if err := document.preparePolicies(); err != nil {
		return err
	}
	if err := document.prepareRuleKinds(); err != nil {
		return err
	}
	return document.prepareSignals()
}

func (document *Document) preparePolicies() error {
	if len(document.Policies) == 0 {
		return fmt.Errorf("%w: policies 为空", ErrInvalidContract)
	}
	document.policyIndex = make(map[string]Policy, len(document.Policies))
	for _, policy := range document.Policies {
		kind := strings.TrimSpace(policy.Kind)
		if kind == "" {
			return fmt.Errorf("%w: policy.kind 为空", ErrInvalidContract)
		}
		if _, duplicated := document.policyIndex[kind]; duplicated {
			return fmt.Errorf("%w: policy.kind=%s 重复", ErrInvalidContract, kind)
		}
		if err := validatePolicy(policy); err != nil {
			return err
		}
		document.policyIndex[kind] = policy
	}
	return nil
}

func (document *Document) prepareRuleKinds() error {
	document.ruleIndex = make(map[string]RuleKind, len(document.RuleKinds))
	for _, entry := range document.RuleKinds {
		kind := strings.TrimSpace(entry.Kind)
		if kind == "" {
			return fmt.Errorf("%w: rule_kind.kind 为空", ErrInvalidContract)
		}
		if _, duplicated := document.ruleIndex[kind]; duplicated {
			return fmt.Errorf("%w: rule_kind.kind=%s 重复", ErrInvalidContract, kind)
		}
		policy, found := document.policyIndex[strings.TrimSpace(entry.Semantic)]
		if !found {
			return fmt.Errorf("%w: rule_kind=%s 引用了未知语义 %s", ErrInvalidContract, kind, entry.Semantic)
		}
		if entry.BlockScope != "" && !validScope(entry.BlockScope) {
			return fmt.Errorf("%w: rule_kind=%s block_scope=%s 无效", ErrInvalidContract, kind, entry.BlockScope)
		}
		blocking := entry.Blocking == nil || *entry.Blocking
		if blockingAction(policy.Action) && blocking &&
			entry.BlockScope == "" && policy.DefaultBlockScope == "" {
			return fmt.Errorf("%w: rule_kind=%s 的阻塞语义 %s 缺少 block_scope", ErrInvalidContract, kind, entry.Semantic)
		}
		if !blocking && entry.BlockScope != "" {
			return fmt.Errorf("%w: rule_kind=%s 非阻塞映射不能声明 block_scope", ErrInvalidContract, kind)
		}
		document.ruleIndex[kind] = entry
	}
	return nil
}

func (document *Document) prepareSignals() error {
	seen := make(map[string]bool, len(document.Signals))
	document.signals = append([]Signal(nil), document.Signals...)
	document.order = make([]int, 0, len(document.signals))
	for index := range document.signals {
		signal := &document.signals[index]
		signal.ID = strings.TrimSpace(signal.ID)
		if signal.ID == "" {
			return fmt.Errorf("%w: signal.id 为空", ErrInvalidContract)
		}
		if seen[signal.ID] {
			return fmt.Errorf("%w: signal.id=%s 重复", ErrInvalidContract, signal.ID)
		}
		seen[signal.ID] = true
		if strings.TrimSpace(signal.Provider) == "" {
			return fmt.Errorf("%w: signal=%s provider 为空", ErrInvalidContract, signal.ID)
		}
		if _, found := document.policyIndex[strings.TrimSpace(signal.Semantic)]; !found {
			return fmt.Errorf("%w: signal=%s 引用了未知语义 %s", ErrInvalidContract, signal.ID, signal.Semantic)
		}
		if signal.BlockScope != "" && !validScope(signal.BlockScope) {
			return fmt.Errorf("%w: signal=%s block_scope=%s 无效", ErrInvalidContract, signal.ID, signal.BlockScope)
		}
		if !signal.hasMatcher() {
			return fmt.Errorf("%w: signal=%s 没有任何匹配条件", ErrInvalidContract, signal.ID)
		}
		if signal.Priority < 0 {
			return fmt.Errorf("%w: signal=%s priority 不能为负", ErrInvalidContract, signal.ID)
		}
		for _, status := range signal.Statuses {
			if status < 100 || status > 599 {
				return fmt.Errorf("%w: signal=%s status=%d 无效", ErrInvalidContract, signal.ID, status)
			}
		}
		if signal.StatusMin != nil && signal.StatusMax != nil &&
			*signal.StatusMin > *signal.StatusMax {
			return fmt.Errorf("%w: signal=%s status 区间反向", ErrInvalidContract, signal.ID)
		}
		if signal.RetryAfterOverMS != nil && *signal.RetryAfterOverMS < 0 {
			return fmt.Errorf("%w: signal=%s retry_after_over_ms 不能为负", ErrInvalidContract, signal.ID)
		}
		if signal.Source == "" {
			signal.Source = SourceBuiltin
		}
		signal.layer = 1
		if signal.Source == SourceOverride {
			signal.layer = 0
		}
		document.order = append(document.order, index)
	}
	sort.SliceStable(document.order, func(left, right int) bool {
		a := document.signals[document.order[left]]
		b := document.signals[document.order[right]]
		if a.layer != b.layer {
			return a.layer < b.layer
		}
		aExact := !strings.EqualFold(strings.TrimSpace(a.Provider), "all")
		bExact := !strings.EqualFold(strings.TrimSpace(b.Provider), "all")
		if aExact != bExact {
			return aExact
		}
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		return document.order[left] < document.order[right]
	})
	document.Signals = document.signals
	return nil
}

func (signal Signal) hasMatcher() bool {
	return len(signal.Statuses) > 0 ||
		signal.StatusMin != nil ||
		signal.StatusMax != nil ||
		strings.TrimSpace(signal.ErrorType) != "" ||
		strings.TrimSpace(signal.ErrorCode) != "" ||
		len(signal.ErrorTypeOrCode) > 0 ||
		signal.RetryAfterOverMS != nil ||
		len(signal.RequireConditions) > 0
}

func validatePolicy(policy Policy) error {
	action := strings.TrimSpace(policy.Action)
	switch action {
	case "model_cooldown":
		if policy.Threshold < 1 || policy.Threshold > 10 {
			return fmt.Errorf("%w: policy=%s threshold=%d 必须在 1..10", ErrInvalidContract, policy.Kind, policy.Threshold)
		}
		if policy.Threshold > 1 && policy.FailureWindowMS <= 0 {
			return fmt.Errorf("%w: policy=%s threshold>1 时 failure_window_ms 必须大于 0", ErrInvalidContract, policy.Kind)
		}
		if policy.FailureWindowMS < 0 {
			return fmt.Errorf("%w: policy=%s failure_window_ms 不能为负", ErrInvalidContract, policy.Kind)
		}
		if policy.DefaultCooldownMS <= 0 {
			return fmt.Errorf("%w: policy=%s default_cooldown_ms 必须大于 0", ErrInvalidContract, policy.Kind)
		}
		if len(policy.BlockScopes) > 0 || policy.Recovery != "" {
			return fmt.Errorf("%w: policy=%s cooldown 语义不能声明阻塞字段", ErrInvalidContract, policy.Kind)
		}
		return nil
	case "no_state_change":
		if policy.Threshold != 0 || policy.FailureWindowMS != 0 || policy.DefaultCooldownMS != 0 {
			return fmt.Errorf("%w: policy=%s no_state_change 不能声明冷却字段", ErrInvalidContract, policy.Kind)
		}
		if len(policy.BlockScopes) > 0 || policy.Recovery != "" {
			return fmt.Errorf("%w: policy=%s no_state_change 不能声明阻塞字段", ErrInvalidContract, policy.Kind)
		}
		return nil
	case "credential_block", "quota_block", "policy_block":
		if len(policy.BlockScopes) == 0 {
			return fmt.Errorf("%w: policy=%s 阻塞语义缺少 block_scopes", ErrInvalidContract, policy.Kind)
		}
		for _, scope := range policy.BlockScopes {
			if !validScope(scope) {
				return fmt.Errorf("%w: policy=%s block_scope=%s 无效", ErrInvalidContract, policy.Kind, scope)
			}
		}
		if policy.DefaultBlockScope != "" && !containsScope(policy.BlockScopes, policy.DefaultBlockScope) {
			return fmt.Errorf("%w: policy=%s default_block_scope 不在 block_scopes 内", ErrInvalidContract, policy.Kind)
		}
		if strings.TrimSpace(policy.Recovery) == "" {
			return fmt.Errorf("%w: policy=%s 阻塞语义缺少 recovery", ErrInvalidContract, policy.Kind)
		}
		return nil
	default:
		return fmt.Errorf("%w: policy=%s action=%s 无效", ErrInvalidContract, policy.Kind, policy.Action)
	}
}

func blockingAction(action string) bool {
	switch strings.TrimSpace(action) {
	case "credential_block", "quota_block", "policy_block":
		return true
	default:
		return false
	}
}

func validScope(scope string) bool {
	switch strings.TrimSpace(scope) {
	case "account", "account_model":
		return true
	default:
		return false
	}
}

func containsScope(scopes []string, scope string) bool {
	for _, candidate := range scopes {
		if strings.EqualFold(strings.TrimSpace(candidate), strings.TrimSpace(scope)) {
			return true
		}
	}
	return false
}

func matchesProvider(signalProvider, inputProvider string) bool {
	signalProvider = normalizeToken(signalProvider)
	if signalProvider == "" || signalProvider == "all" {
		return true
	}
	return signalProvider == inputProvider
}

func matchesStatus(signal Signal, status int) bool {
	if len(signal.Statuses) > 0 {
		found := false
		for _, candidate := range signal.Statuses {
			if candidate == status {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if signal.StatusMin != nil && status < *signal.StatusMin {
		return false
	}
	if signal.StatusMax != nil && status > *signal.StatusMax {
		return false
	}
	return true
}

func matchesError(signal Signal, errorType, errorCode string) bool {
	if value := normalizeToken(signal.ErrorType); value != "" && value != errorType {
		return false
	}
	if value := normalizeToken(signal.ErrorCode); value != "" && value != errorCode {
		return false
	}
	if len(signal.ErrorTypeOrCode) > 0 {
		found := false
		for _, candidate := range signal.ErrorTypeOrCode {
			value := normalizeToken(candidate)
			if value != "" && (value == errorType || value == errorCode) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func matchesConditions(required []string, conditions map[string]bool) bool {
	for _, condition := range required {
		if !conditions[normalizeToken(condition)] {
			return false
		}
	}
	return true
}

func normalizeToken(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// mergeOverride 把全局覆盖合并进内置契约，返回新的不可变文档。
func mergeOverride(base *Document, override *Override) (*Document, error) {
	merged := &Document{
		SchemaVersion: base.SchemaVersion,
		Policies:      append([]Policy(nil), base.Policies...),
		Signals:       cloneSignals(base.Signals),
		RuleKinds:     append([]RuleKind(nil), base.RuleKinds...),
	}
	disabled := map[string]bool{}
	if override != nil {
		for kind, patch := range override.Policies {
			index, found := findPolicy(merged.Policies, kind)
			if !found {
				return nil, fmt.Errorf("%w: 覆盖引用了未知 policy=%s", ErrInvalidContract, kind)
			}
			policy := merged.Policies[index]
			if patch.Threshold != nil {
				policy.Threshold = *patch.Threshold
			}
			if patch.FailureWindowMS != nil {
				policy.FailureWindowMS = *patch.FailureWindowMS
			}
			if patch.DefaultCooldownMS != nil {
				policy.DefaultCooldownMS = *patch.DefaultCooldownMS
			}
			merged.Policies[index] = policy
		}
		disabled = make(map[string]bool, len(override.Disable))
		for _, id := range override.Disable {
			disabled[strings.TrimSpace(id)] = true
		}
		for index := range merged.Signals {
			signal := &merged.Signals[index]
			signal.Source = SourceBuiltin
			if disabled[signal.ID] {
				enabled := false
				signal.Enabled = &enabled
				signal.Shadowed = true
			}
		}
		for _, signal := range override.Signals {
			signal.Source = SourceOverride
			signal.layer = 0
			merged.Signals = append(merged.Signals, signal)
		}
	}
	if err := merged.prepare(); err != nil {
		return nil, err
	}
	// prepare 会把内置行标记为 SourceBuiltin；覆盖行保持 SourceOverride。
	for index := range merged.Signals {
		if disabled[merged.Signals[index].ID] && merged.Signals[index].Source == SourceBuiltin {
			merged.Signals[index].Shadowed = true
		}
	}
	return merged, nil
}

func findPolicy(policies []Policy, kind string) (int, bool) {
	for index, policy := range policies {
		if strings.EqualFold(strings.TrimSpace(policy.Kind), strings.TrimSpace(kind)) {
			return index, true
		}
	}
	return 0, false
}

func cloneSignals(signals []Signal) []Signal {
	cloned := make([]Signal, len(signals))
	copy(cloned, signals)
	for index := range cloned {
		cloned[index].Statuses = append([]int(nil), signals[index].Statuses...)
		cloned[index].ErrorTypeOrCode = append([]string(nil), signals[index].ErrorTypeOrCode...)
		cloned[index].RequireConditions = append([]string(nil), signals[index].RequireConditions...)
	}
	return cloned
}
