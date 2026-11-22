// Package accountegress 声明账号级出站决策的应用层端口。
//
// 额度采集、OAuth 刷新等应用服务只负责把"本次请求属于哪个账号"解析成
// Decision 并放进 Context；具体代理选择与连接池由宿主实现。
package accountegress

import "context"

// Decision 是账号本次出站应使用的出口。
//
//   - Bound=false：账号没有出口绑定，沿用调用方默认网络；
//   - Bound=true 且 Direct=true：显式直连，必须绕开环境代理；
//   - Bound=true 且 ProxyURL 非空：使用该代理。
type Decision struct {
	Bound    bool
	Direct   bool
	ProxyURL string
}

// Resolver 解析账号的出口决策。
type Resolver interface {
	ResolveAccountEgress(ctx context.Context, provider string, accountRef string) (Decision, error)
}

type decisionKey struct{}

// WithDecision 把本次请求的出口决策放进 Context。
func WithDecision(ctx context.Context, decision Decision) context.Context {
	if ctx == nil {
		return ctx
	}
	return context.WithValue(ctx, decisionKey{}, decision)
}

// DecisionFromContext 读取本次请求的出口决策。
func DecisionFromContext(ctx context.Context) (Decision, bool) {
	if ctx == nil {
		return Decision{}, false
	}
	decision, ok := ctx.Value(decisionKey{}).(Decision)
	return decision, ok
}
