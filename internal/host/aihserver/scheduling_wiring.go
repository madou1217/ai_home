package aihserver

import (
	"github.com/madou1217/ai_home/application/accountscheduling"
	codebuddycnpolicy "github.com/madou1217/ai_home/internal/adapters/scheduling/codebuddycn"
)

// newSchedulingEvaluator 构造进程内的调度策略表。
//
// Recruiter（实际选号）与 WebUI 路由诊断消费同一套 Policy：新增 Provider 只在这里
// 注册一个策略，两条路径同时生效，调度器本身不需要任何 Provider 分支。
func newSchedulingEvaluator() *accountscheduling.Evaluator {
	return accountscheduling.NewEvaluator(accountscheduling.NewRegistry(
		accountscheduling.NewDefaultPolicy(""),
		codebuddycnpolicy.NewPolicy(),
	))
}
