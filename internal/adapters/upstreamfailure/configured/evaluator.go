package configured

import (
	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// Evaluator 把账号规则服务组合成 Provider 适配器可用的规则求值端口。
//
// 它只做组合：识别在 core/upstreamrules，分类映射在本包 Classify，配置与拼装在
// application/upstreamrules。任何一层缺席（service 为 nil）都退化为「不承接」。
type Evaluator struct {
	service *rulesapp.Service
}

// NewEvaluator 创建基于账号规则服务的求值器；service 为 nil 时返回 nil（能力关闭）。
func NewEvaluator(service *rulesapp.Service) *Evaluator {
	if service == nil {
		return nil
	}
	return &Evaluator{service: service}
}

// Evaluate 实现 Rules 端口。
func (evaluator *Evaluator) Evaluate(
	accountRef string,
	statusCode int,
	body []byte,
) (sharedfailure.Classification, bool) {
	if evaluator == nil || evaluator.service == nil {
		return sharedfailure.Classification{}, false
	}
	rules, ok := evaluator.service.RulesFor(accountRef)
	if !ok || len(rules) == 0 {
		return sharedfailure.Classification{}, false
	}
	classification, matched, err := Evaluate(rules, statusCode, body)
	if err != nil {
		// 映射失败按未命中处理：账号配置问题不能改变上游失败的既有分类。
		return sharedfailure.Classification{}, false
	}
	return classification, matched
}
