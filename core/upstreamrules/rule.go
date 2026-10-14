// Package upstreamrules 定义账号自定义上游错误规则的纯领域模型。
//
// 该包只回答「这条上游错误命中了哪条用户配置的规则」，不依赖 HTTP、数据库、
// Provider SDK 或运行态 Registry。规则来源（账号直接规则、错误映射分组）与
// 生效判定（enabled、状态码白名单）都在这里，避免各调用点自行解释配置。
//
// 与 Node 控制面（lib/account/upstream-error-rules.js）保持同构：Node 是规则
// 的唯一写入与校验入口，Go 只消费 Node 已经归一化过的规则，因此本包接受集合
// 必须是 Node 接受集合的超集。
package upstreamrules

import (
	"errors"
	"fmt"
)

const (
	// MaxRules 是单个账号允许的规则条数上限。
	MaxRules = 20
	// MaxMatchers 是单条规则允许的匹配条件上限。
	MaxMatchers = 8
	// MaxNameLength 是规则名称上限。
	MaxNameLength = 80
	// MaxPatternLength 是正则文本上限。
	MaxPatternLength = 256
	// MaxValueLength 是匹配值文本上限。
	MaxValueLength = 4096
	// MaxPathLength 是 JSON 点路径上限。
	MaxPathLength = 256
	// MaxPathSegments 是 JSON 点路径段数上限。
	MaxPathSegments = 16
	// MaxStatuses 是状态码白名单长度上限。
	MaxStatuses = 20
)

// ErrInvalidRules 表示规则集合不符合领域约束。
var ErrInvalidRules = errors.New("上游错误规则无效")

// Kind 是规则命中的目标状态；取值与 Node 控制面一致。
type Kind string

const (
	// KindBillingBlocked 表示账号账单状态阻止继续使用。
	KindBillingBlocked Kind = "billing_blocked"
	// KindQuotaExhausted 表示额度窗口或模型额度已经耗尽。
	KindQuotaExhausted Kind = "quota_exhausted"
	// KindAuthInvalid 表示上游拒绝当前账号凭据。
	KindAuthInvalid Kind = "auth_invalid"
	// KindPermissionDenied 表示凭据有效但无权访问当前资源。
	KindPermissionDenied Kind = "permission_denied"
	// KindRateLimited 表示普通速率限制。
	KindRateLimited Kind = "rate_limited"
	// KindServiceUnavailable 表示上游暂时不可用。
	KindServiceUnavailable Kind = "service_unavailable"
)

// IsHardBlock 判断该状态是否属于立即账号级硬阻塞。
//
// 硬阻塞不受 cooldown 约束，必须等待外部真相源更新（Node 语义：cooldownMs = 0）。
func (kind Kind) IsHardBlock() bool {
	switch kind {
	case KindBillingBlocked, KindQuotaExhausted, KindPermissionDenied:
		return true
	default:
		return false
	}
}

// IsAccountScoped 判断该状态是否作用于整个账号。
func (kind Kind) IsAccountScoped() bool {
	return kind.IsHardBlock() || kind == KindAuthInvalid
}

// Source 是匹配来源。
type Source string

const (
	// SourceHTTPCode 匹配 HTTP 状态码。
	SourceHTTPCode Source = "http_code"
	// SourceBody 匹配错误正文文本。
	SourceBody Source = "body"
	// SourceJSON 匹配正文 JSON 的点路径取值。
	SourceJSON Source = "json"
)

// Operator 是匹配方式。
type Operator string

const (
	// OperatorRegex 表示正则匹配（大小写不敏感）。
	OperatorRegex Operator = "regex"
	// OperatorContains 表示包含匹配。
	OperatorContains Operator = "contains"
	// OperatorEquals 表示相等匹配。
	OperatorEquals Operator = "equals"
)

// Field 是旧版规则的匹配字段。
type Field string

const (
	// FieldCode 匹配结构化错误 code。
	FieldCode Field = "code"
	// FieldType 匹配结构化错误 type。
	FieldType Field = "type"
	// FieldMessage 匹配结构化错误 message。
	FieldMessage Field = "message"
	// FieldBody 匹配错误正文文本。
	FieldBody Field = "body"
)

// validKind 判断状态是否为已注册取值。
func validKind(kind Kind) bool {
	switch kind {
	case KindBillingBlocked, KindQuotaExhausted, KindAuthInvalid,
		KindPermissionDenied, KindRateLimited, KindServiceUnavailable:
		return true
	default:
		return false
	}
}

// invalid 构造统一的规则校验错误。
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidRules, fmt.Sprintf(format, args...))
}
