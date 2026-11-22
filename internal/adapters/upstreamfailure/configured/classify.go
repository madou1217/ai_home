// Package configured 把账号自定义上游错误规则映射为统一运行态分类。
//
// 规则识别属于领域（core/upstreamrules），分类映射属于适配层：只有这里知道
// 「用户配的 quota_exhausted 应该变成哪个 FailureKind、带什么作用域和冷却」。
// 该包同时提供所有 Provider 共用的求值顺序装饰器，避免各调用点各自解释优先级。
package configured

import (
	"net/http"
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/upstreamrules"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
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
			return classification.WithObservedHTTPStatus(statusCode)
		}
	}
	classification, err := builtin()
	if err != nil {
		return classification, err
	}
	return classification.WithObservedHTTPStatus(statusCode)
}

// ClassifyHTTPWithRules 在 ClassifyWithRules 的基础上，无论命中自定义规则还是内置分类，
// 都把真实 HTTP 响应头中的 Retry-After 事实独立附加到最终分类（保留规则决定的类型与阻塞语义）。
func ClassifyHTTPWithRules(
	rules Rules,
	accountRef string,
	statusCode int,
	header http.Header,
	body []byte,
	observedAt time.Time,
	builtin func() (sharedfailure.Classification, error),
) (sharedfailure.Classification, error) {
	classification, err := ClassifyWithRules(rules, accountRef, statusCode, body, builtin)
	if err != nil {
		return classification, err
	}
	return sharedfailure.AttachExplicitRetryAfter(classification, header, observedAt), nil
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
// 规则 kind → 失败语义 → 作用域/冷却全部来自 contracts/upstream-failure 的
// rule_kinds 表：新增一种规则动作只加一行数据，不再改这里的分支。
func Classify(rule upstreamrules.Rule) (sharedfailure.Classification, error) {
	entry, found := failurecontract.Default().RuleKind(string(rule.Kind()))
	if !found {
		return sharedfailure.Classification{}, upstreamrules.ErrInvalidRules
	}
	kind := runtimecore.FailureKind(entry.Semantic)
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil {
		return sharedfailure.Classification{}, upstreamrules.ErrInvalidRules
	}
	blocking := entry.Blocking == nil || *entry.Blocking
	if blocking && policy.BlocksRouting() {
		scope := runtimecore.BlockScope(entry.BlockScope)
		if scope == "" {
			defaultScope, ok := policy.DefaultBlockScope()
			if !ok {
				return sharedfailure.Classification{}, upstreamrules.ErrInvalidRules
			}
			scope = defaultScope
		}
		return sharedfailure.NewBlockingClassification(kind, scope)
	}
	retryAfter := time.Duration(0)
	if policy.EntersCooldown() {
		retryAfter = policy.DefaultCooldown()
	}
	return sharedfailure.NewClassification(kind, retryAfter)
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
