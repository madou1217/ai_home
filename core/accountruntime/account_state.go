package accountruntime

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidAccountState 表示账号运行态文档不是有界 JSON 对象，或已知字段越界。
	ErrInvalidAccountState = errors.New("账号运行态文档无效")
)

const (
	// MaxAccountStateBytes 限制单个账号运行态文档的持久化体积。
	MaxAccountStateBytes = 64 * 1024
	// maxAccountStateTextLength 限制原因/错误文本，避免把上游响应写进库。
	maxAccountStateTextLength = 500
	// maxAccountStateKindLength 限制失败类型长度。
	maxAccountStateKindLength = 64
	// maxAccountStateModelEntries 限制按模型记录的冷却条数。
	maxAccountStateModelEntries = 512
	// maxAccountStateModelKeyLength 限制模型 ID 长度。
	maxAccountStateModelKeyLength = 256
	// maxAccountStateTimeMS 是 SQLite 侧允许的最大毫秒时间戳。
	maxAccountStateTimeMS = int64(253_402_300_799_999)
)

// AccountStateStatus 是账号运行态派生出的可展示结论。
//
// 状态词与 Node 的 deriveAccountRuntimeStatus 完全一致：healthy、auth_invalid、
// rate_limited、overloaded、transient_network、service_unavailable、upstream_error、
// cooling_down，以及 routingBlock 自带的 kind（billing_blocked / quota_exhausted / ...）。
type AccountStateStatus struct {
	status string
	until  time.Time
	reason string
}

// Status 返回状态词。
func (status AccountStateStatus) Status() string { return status.status }

// Until 返回解除时间；healthy 为零值。
func (status AccountStateStatus) Until() time.Time { return status.until }

// Reason 返回最近一次失败原因。
func (status AccountStateStatus) Reason() string { return status.reason }

// IsHealthy 表示当前没有生效的账号级阻塞或冷却。
func (status AccountStateStatus) IsHealthy() bool { return status.status == "healthy" }

// AccountState 是校验后的账号运行态文档。
//
// 文档保留 Node 写入的完整 JSON（包括 Go 尚未建模的字段），派生只读取已知字段；
// 这样后续读取方可以原样取回，不会因为 Go 升级而丢字段。
type AccountState struct {
	accountRef accountcore.AccountRef
	document   []byte
	parsed     accountStateDocument
	updatedAt  time.Time
}

// AccountStateInput 是写入一份账号运行态文档的完整输入。
type AccountStateInput struct {
	AccountRef accountcore.AccountRef
	Document   []byte
	UpdatedAt  time.Time
}

// accountStateDocument 是派生需要的已知字段投影；未知字段在原始文档里保留。
type accountStateDocument struct {
	CooldownUntil           *float64 `json:"cooldownUntil"`
	ConsecutiveFailures     *float64 `json:"consecutiveFailures"`
	SuccessCount            *float64 `json:"successCount"`
	FailCount               *float64 `json:"failCount"`
	LastError               string   `json:"lastError"`
	LastFailureKind         string   `json:"lastFailureKind"`
	LastFailureReason       string   `json:"lastFailureReason"`
	LastFailureAt           *float64 `json:"lastFailureAt"`
	LastSuccessAt           *float64 `json:"lastSuccessAt"`
	RateLimitUntil          *float64 `json:"rateLimitUntil"`
	AuthInvalidUntil        *float64 `json:"authInvalidUntil"`
	OverloadUntil           *float64 `json:"overloadUntil"`
	NetworkUntil            *float64 `json:"networkUntil"`
	ServiceUnavailableUntil *float64 `json:"serviceUnavailableUntil"`
	UpstreamErrorUntil      *float64 `json:"upstreamErrorUntil"`
	RoutingBlock            *struct {
		Kind       string   `json:"kind"`
		Reason     string   `json:"reason"`
		ObservedAt *float64 `json:"observedAt"`
		Until      *float64 `json:"until"`
	} `json:"routingBlock"`
	ModelCooldowns      map[string]float64         `json:"modelCooldowns"`
	ModelFailureStreaks map[string]json.RawMessage `json:"modelFailureStreaks"`
}

// NewAccountState 校验账号、大小、JSON 形状与已知字段边界。
//
// 未知字段被保留但不参与派生；已知数值字段必须是有限的非负毫秒时间戳，
// 已知文本字段必须是有界 UTF-8。
func NewAccountState(input AccountStateInput) (AccountState, error) {
	if !input.AccountRef.IsValid() {
		return AccountState{}, ErrInvalidAccountState
	}
	updatedAt, updatedValid := normalizeAccountStateTime(input.UpdatedAt)
	if !updatedValid {
		return AccountState{}, ErrInvalidAccountState
	}
	document := bytes.TrimSpace(input.Document)
	if len(document) < 2 || len(document) > MaxAccountStateBytes ||
		document[0] != '{' || document[len(document)-1] != '}' {
		return AccountState{}, ErrInvalidAccountState
	}
	var parsed accountStateDocument
	decoder := json.NewDecoder(bytes.NewReader(document))
	if err := decoder.Decode(&parsed); err != nil {
		return AccountState{}, ErrInvalidAccountState
	}
	if !parsed.valid() {
		return AccountState{}, ErrInvalidAccountState
	}
	return AccountState{
		accountRef: input.AccountRef,
		document:   document,
		parsed:     parsed,
		updatedAt:  updatedAt,
	}, nil
}

// AccountRef 返回文档所属账号。
func (state AccountState) AccountRef() accountcore.AccountRef { return state.accountRef }

// Document 返回原始运行态 JSON 的副本。
func (state AccountState) Document() []byte {
	document := make([]byte, len(state.document))
	copy(document, state.document)
	return document
}

// UpdatedAt 返回文档最后写入时间。
func (state AccountState) UpdatedAt() time.Time { return state.updatedAt }

// IsValid 重新校验跨层传递后的不可变文档。
func (state AccountState) IsValid() bool {
	restored, err := NewAccountState(AccountStateInput{
		AccountRef: state.accountRef,
		Document:   state.document,
		UpdatedAt:  state.updatedAt,
	})
	return err == nil && restored.updatedAt.Equal(state.updatedAt)
}

// DeriveStatus 按与 Node 相同的优先级给出账号运行态结论。
//
// 顺序不能调整：routingBlock 是硬阻塞（账单/权限/额度），优先于任何冷却；
// 之后按失败类型固定排序，最后才是通用 cooldownUntil。
func (state AccountState) DeriveStatus(now time.Time) AccountStateStatus {
	nowMS := now.UnixMilli()
	if state.parsed.RoutingBlock != nil {
		block := state.parsed.RoutingBlock
		untilMS := int64FromPointer(block.Until)
		if untilMS > nowMS {
			return AccountStateStatus{
				status: strings.TrimSpace(block.Kind),
				until:  timeFromUnixMilli(untilMS),
				reason: strings.TrimSpace(block.Reason),
			}
		}
	}
	reason := state.parsed.failureReason()
	ordered := []struct {
		status string
		until  *float64
	}{
		{"auth_invalid", state.parsed.AuthInvalidUntil},
		{"rate_limited", state.parsed.RateLimitUntil},
		{"overloaded", state.parsed.OverloadUntil},
		{"transient_network", state.parsed.NetworkUntil},
		{"service_unavailable", state.parsed.ServiceUnavailableUntil},
		{"upstream_error", state.parsed.UpstreamErrorUntil},
	}
	for _, entry := range ordered {
		untilMS := int64FromPointer(entry.until)
		if untilMS > nowMS {
			return AccountStateStatus{
				status: entry.status,
				until:  timeFromUnixMilli(untilMS),
				reason: reason,
			}
		}
	}
	cooldownMS := int64FromPointer(state.parsed.CooldownUntil)
	if cooldownMS > nowMS {
		status := strings.TrimSpace(state.parsed.LastFailureKind)
		if status == "" {
			status = "cooling_down"
		}
		return AccountStateStatus{
			status: status,
			until:  timeFromUnixMilli(cooldownMS),
			reason: reason,
		}
	}
	return AccountStateStatus{status: "healthy"}
}

func (document accountStateDocument) failureReason() string {
	if reason := strings.TrimSpace(document.LastFailureReason); reason != "" {
		return reason
	}
	return strings.TrimSpace(document.LastError)
}

// valid 校验已知字段的类型与边界。
func (document accountStateDocument) valid() bool {
	times := []*float64{
		document.CooldownUntil,
		document.LastFailureAt,
		document.LastSuccessAt,
		document.RateLimitUntil,
		document.AuthInvalidUntil,
		document.OverloadUntil,
		document.NetworkUntil,
		document.ServiceUnavailableUntil,
		document.UpstreamErrorUntil,
	}
	for _, value := range times {
		if !validAccountStateTime(value) {
			return false
		}
	}
	counters := []*float64{
		document.ConsecutiveFailures,
		document.SuccessCount,
		document.FailCount,
	}
	for _, value := range counters {
		if value != nil && (*value < 0 || *value > 1_000_000) {
			return false
		}
	}
	if !validAccountStateText(document.LastError) ||
		!validAccountStateText(document.LastFailureReason) ||
		len(document.LastFailureKind) > maxAccountStateKindLength ||
		!validAccountStateText(document.LastFailureKind) {
		return false
	}
	if block := document.RoutingBlock; block != nil {
		if strings.TrimSpace(block.Kind) == "" ||
			len(block.Kind) > maxAccountStateKindLength ||
			!validAccountStateText(block.Kind) ||
			!validAccountStateText(block.Reason) ||
			!validAccountStateTime(block.ObservedAt) ||
			!validAccountStateTime(block.Until) {
			return false
		}
	}
	if len(document.ModelCooldowns) > maxAccountStateModelEntries ||
		len(document.ModelFailureStreaks) > maxAccountStateModelEntries {
		return false
	}
	for model, until := range document.ModelCooldowns {
		if !validAccountStateModelKey(model) || !validAccountStateTime(&until) {
			return false
		}
	}
	for model := range document.ModelFailureStreaks {
		if !validAccountStateModelKey(model) {
			return false
		}
	}
	return true
}

func validAccountStateModelKey(model string) bool {
	return model != "" &&
		len(model) <= maxAccountStateModelKeyLength &&
		model == strings.TrimSpace(model) &&
		validAccountStateText(model)
}

func validAccountStateText(value string) bool {
	if len(value) > maxAccountStateTextLength {
		return false
	}
	return utf8.ValidString(value)
}

func validAccountStateTime(value *float64) bool {
	if value == nil {
		return true
	}
	if *value < 0 || *value > float64(maxAccountStateTimeMS) {
		return false
	}
	return *value == float64(int64(*value))
}

func int64FromPointer(value *float64) int64 {
	if value == nil {
		return 0
	}
	return int64(*value)
}

func normalizeAccountStateTime(value time.Time) (time.Time, bool) {
	if value.IsZero() {
		return time.Time{}, false
	}
	unixMS := value.UnixMilli()
	if unixMS < 0 || unixMS > maxAccountStateTimeMS {
		return time.Time{}, false
	}
	return time.UnixMilli(unixMS).UTC(), true
}

func timeFromUnixMilli(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}

// nodeFailureKinds 把 Node 运行态里的失败词映射为 Go 的稳定 FailureKind。
//
// 只映射 Go 已注册的类型；未识别的观察不物化成阻塞（状态派生仍然可用）。
var nodeFailureKinds = map[string]FailureKind{
	"auth_invalid":          FailureReauthenticationRequired,
	"credential_rejected":   FailureCredentialRejected,
	"rate_limited":          FailureRateLimited,
	"permission_denied":     FailurePermissionDenied,
	"billing_blocked":       FailureBillingBlocked,
	"quota_exhausted":       FailureQuotaExhausted,
	"workspace_deactivated": FailureWorkspaceDeactivated,
	"region_unsupported":    FailureRegionUnsupported,
	"overloaded":            FailureModelOverloaded,
	"model_overloaded":      FailureModelOverloaded,
	"service_unavailable":   FailureUpstreamUnavailable,
	"upstream_error":        FailureUpstreamUnavailable,
	"transient_network":     FailureConnectionReset,
}

// DeriveBlock 从运行态文档物化一条账号级失败阻塞。
//
// 口径与 Node 的上报映射一致：优先 routingBlock，其次 lastFailureKind。
// 没有可映射的失败、没有观察时间或 until 不晚于观察时间时返回 false。
func (state AccountState) DeriveBlock() (AccountBlock, bool) {
	kind := ""
	observedAtMS := int64(0)
	untilMS := int64(0)
	reason := ""
	if block := state.parsed.RoutingBlock; block != nil {
		kind = strings.TrimSpace(block.Kind)
		observedAtMS = int64FromPointer(block.ObservedAt)
		untilMS = int64FromPointer(block.Until)
		reason = strings.TrimSpace(block.Reason)
	}
	if kind == "" {
		kind = strings.TrimSpace(state.parsed.LastFailureKind)
		observedAtMS = int64FromPointer(state.parsed.LastFailureAt)
		// 与 Node 的上报口径一致：优先该失败类型自己的 until，缺失时才用通用 cooldown。
		if kind == "auth_invalid" {
			untilMS = firstNonZero(
				int64FromPointer(state.parsed.AuthInvalidUntil),
				int64FromPointer(state.parsed.CooldownUntil),
			)
		} else {
			untilMS = firstNonZero(
				int64FromPointer(state.parsed.RateLimitUntil),
				int64FromPointer(state.parsed.CooldownUntil),
			)
		}
		reason = state.parsed.failureReason()
	}
	failureKind, mapped := nodeFailureKinds[kind]
	if !mapped || observedAtMS <= 0 || untilMS <= observedAtMS {
		return AccountBlock{}, false
	}
	block, err := NewAccountBlock(AccountBlockInput{
		AccountRef: state.accountRef,
		Kind:       failureKind,
		Scope:      BlockScopeAccount,
		Reason:     reason,
		ObservedAt: timeFromUnixMilli(observedAtMS),
		Until:      timeFromUnixMilli(untilMS),
	})
	if err != nil {
		return AccountBlock{}, false
	}
	return block, true
}

func firstNonZero(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}
