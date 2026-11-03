// Package configured 把账号自定义上游错误规则映射为统一运行态分类。
//
// 规则识别属于领域（core/upstreamrules），分类映射属于适配层：只有这里知道
// 「用户配的 quota_exhausted 应该变成哪个 FailureKind、带什么作用域和冷却」。
// 该包同时提供所有 Provider 共用的求值顺序装饰器，避免各调用点各自解释优先级。
package configured

import (
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/upstreamrules"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// rateLimitedCooldown 与 Node 规则策略的 rate_limited 冷却一致（统一的猜测冷却）。
	rateLimitedCooldown = runtimecore.GuessedCooldown
	// serviceUnavailableCooldown 与 Node 规则策略的 service_unavailable 冷却一致。
	serviceUnavailableCooldown = runtimecore.GuessedCooldown
)

// Rules 是账号自定义规则求值端口；为 nil 表示 Go 未承接该能力。
type Rules interface {
	// Evaluate 返回命中规则映射出的分类；未命中返回 false。
	Evaluate(
		accountRef string,
		statusCode int,
		body []byte,
	) (sharedfailure.Classification, bool)
}

// ClassifyWithRules 先应用账号自定义规则，未命中再回落到内置分类器。
//
// 顺序与 Node classifyUpstreamFailure 一致：用户配置优先于内置启发式，因此命中
// 规则的上游错误不会被内置分类改写成另一个状态。rules 为 nil 或账号未知时
// 行为与不接入本能力完全相同（零行为差异的渐进接入点）。
func ClassifyWithRules(
	rules Rules,
	accountRef string,
	statusCode int,
	body []byte,
	builtin func() (sharedfailure.Classification, error),
) (sharedfailure.Classification, error) {
	if rules != nil && accountRef != "" {
		if classification, matched := rules.Evaluate(accountRef, statusCode, body); matched {
			return classification, nil
		}
	}
	return builtin()
}

// ClassifySSEWithRules 是流内事件（SSE / WebSocket 帧）的求值装饰器。
//
// 与 ClassifyWithRules 同一优先级：账号自定义规则先于内置观察器，命中即以规则
// 分类作为终态（observed=true）。未命中时逐字节等价于只调用 builtin。
//
// 流内事件也能安全地先跑规则，因为领域观察投影自带失败证据门（HTTP 4xx/5xx，
// 或正文 envelope 明确声明 error / response.failed）：普通内容事件不会命中规则，
// 不会把一次成功事件改写成失败。
func ClassifySSEWithRules(
	rules Rules,
	accountRef string,
	statusCode int,
	body []byte,
	builtin func() (sharedfailure.Classification, bool, error),
) (sharedfailure.Classification, bool, error) {
	if rules != nil && accountRef != "" && len(body) > 0 {
		if classification, matched := rules.Evaluate(accountRef, statusCode, body); matched {
			return classification, true, nil
		}
	}
	return builtin()
}

// Classify 把命中的规则映射为运行态分类。
//
// 作用域与冷却与 Node upstream-error-rule-policy 一致：
//   - billing_blocked / quota_exhausted / permission_denied：账号级硬阻塞，无冷却；
//   - auth_invalid：凭据阻塞（NewClassification 会补默认的账号级解除信号；静态密钥
//     账号随后由 ObservedAttemptRecorder 降级为有限冷却，等价于 Node 的 apiKeyMode 分支）；
//   - rate_limited / service_unavailable：账号+模型短期冷却。
func Classify(rule upstreamrules.Rule) (sharedfailure.Classification, error) {
	switch rule.Kind() {
	case upstreamrules.KindBillingBlocked:
		return sharedfailure.NewBlockingClassification(
			runtimecore.FailureBillingBlocked,
			runtimecore.BlockScopeAccount,
		)
	case upstreamrules.KindQuotaExhausted:
		return sharedfailure.NewBlockingClassification(
			runtimecore.FailureQuotaExhausted,
			runtimecore.BlockScopeAccount,
		)
	case upstreamrules.KindPermissionDenied:
		return sharedfailure.NewBlockingClassification(
			runtimecore.FailurePermissionDenied,
			runtimecore.BlockScopeAccount,
		)
	case upstreamrules.KindAuthInvalid:
		return sharedfailure.NewClassification(
			runtimecore.FailureCredentialRejected,
			0,
		)
	case upstreamrules.KindRateLimited:
		return sharedfailure.NewClassification(
			runtimecore.FailureRateLimited,
			rateLimitedCooldown,
		)
	case upstreamrules.KindServiceUnavailable:
		return sharedfailure.NewClassification(
			runtimecore.FailureUpstreamUnavailable,
			serviceUnavailableCooldown,
		)
	default:
		return sharedfailure.Classification{}, upstreamrules.ErrInvalidRules
	}
}

// Evaluate 对一组规则求值并映射分类。
//
// 第二个返回值表示是否命中；命中但映射失败（未知状态）时返回错误，调用方必须
// 按未命中处理而不是把错误当成失败分类。
//
// 传入的规则必须是 Validate 的产物（即存储层接受的形态）：未经校验的规则不带
// 预编译正则，一律不参与匹配，以免出现「配置生效但从不命中」的静默失配。
func Evaluate(
	rules []upstreamrules.Rule,
	statusCode int,
	body []byte,
) (sharedfailure.Classification, bool, error) {
	rule, matched := upstreamrules.Match(rules, statusCode, body)
	if !matched {
		return sharedfailure.Classification{}, false, nil
	}
	classification, err := Classify(rule)
	if err != nil {
		return sharedfailure.Classification{}, false, err
	}
	return classification, true, nil
}
