package relaycore

import (
	"net/http"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// ProviderChain 把多个透传 Provider 组合成**一个入口**上的通道。
//
// 为什么需要它：同一客户端入口（如 chat completions）上可能挂多个透传 Provider ——
// 家族四支与 cline 都从 `/v1/chat/completions` 进来，各自服务自己那一批账号。
// Handler 只接受一个 Provider，所以需要这一层把「按账号选 Provider」的分派收敛起来。
//
// **语义约定**：链上的差异面方法（Endpoint / AccessToken / RewriteRequest /
// DecorateUpstream / ClassifyFailure）在链本身上没有意义 —— 它们必须在 Resolve 出
// 具体成员之后调用。Handler 正是这么做的（先 Resolve 再取差异面）。链直接调用这些
// 方法会返回保守值而不是 panic：生产路径不会走到，但测试或误用时会得到「交还 Canonical」
// 这个安全结果，而不是崩掉一个正在服务的进程。
type ProviderChain struct {
	members []Provider
}

// NewProviderChain 组合若干 Provider；顺序即 Resolve 的尝试顺序。
func NewProviderChain(members ...Provider) *ProviderChain {
	filtered := make([]Provider, 0, len(members))
	for _, member := range members {
		if member != nil {
			filtered = append(filtered, member)
		}
	}
	return &ProviderChain{members: filtered}
}

// 编译期确认链本身也是一个 Provider（Handler 依赖的是这个接口）。
var _ Provider = (*ProviderChain)(nil)

// ID 返回链的标识（仅用于日志；链服务多个 Provider，故取第一个成员的 ID 加后缀）。
func (chain *ProviderChain) ID() string {
	if chain == nil || len(chain.members) == 0 {
		return "relay-chain"
	}
	return chain.members[0].ID() + "-chain"
}

// Resolve 依次询问每个成员，第一个认领该 Provider 的胜出。
//
// 顺序有意义：成员的认领范围应互不重叠（各自服务自己的 Provider 集），否则先声明者优先。
func (chain *ProviderChain) Resolve(providerID string) (Provider, bool) {
	if chain == nil {
		return nil, false
	}
	for _, member := range chain.members {
		if resolved, ok := member.Resolve(providerID); ok {
			return resolved, true
		}
	}
	return nil, false
}

// Endpoint 在链上无意义（必须先 Resolve）：返回 false，让调用方交还 Canonical。
func (chain *ProviderChain) Endpoint() (string, bool) { return "", false }

// AccessToken 在链上无意义（必须先 Resolve）：一律拒绝，不猜凭据形态。
func (chain *ProviderChain) AccessToken(accountapp.Credential) (string, error) {
	return "", ErrUnsupportedCredential
}

// RewriteRequest 在链上无意义（必须先 Resolve）：原样返回，不做任何改写。
func (chain *ProviderChain) RewriteRequest(body []byte) (RewriteResult, error) {
	return RewriteResult{Body: body}, nil
}

// DecorateUpstream 在链上无意义（必须先 Resolve）：不写任何头。
func (chain *ProviderChain) DecorateUpstream(*http.Request, string) {}

// ClassifyFailure 在链上无意义（必须先 Resolve）：报无失败证据，不猜分类。
func (chain *ProviderChain) ClassifyFailure(
	int, http.Header, []byte, time.Time,
) (sharedfailure.Classification, error) {
	return sharedfailure.Classification{}, sharedfailure.ErrNoFailureEvidence
}
