package claudenativerelay

import (
	"errors"
	"net/http"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// RelayTokenHeader 携带只绑定一个账号模型组合的本地短期 Relay Token。
	RelayTokenHeader  = "X-AIH-Relay-Token"
	minRelayTokenSize = 16
	maxRelayTokenSize = 512
)

// ErrInvalidAuthorizer 表示 Relay Token 解析端口缺失。
var ErrInvalidAuthorizer = errors.New("Claude Native Relay 鉴权依赖无效")

// TokenResolver 原子消费不透明短期 Token 并返回唯一可信账号模型绑定。
//
// 该端口由请求级租约注册表实现；Handler 不接受客户端自报的账号或模型。
type TokenResolver interface {
	ConsumeRelayToken(
		token string,
	) (accountcore.AccountRef, runtimecore.ModelID, bool)
}

// ScopedTokenAuthorizer 使用短期 Token 得到服务端绑定的账号和真实模型。
type ScopedTokenAuthorizer struct {
	tokens TokenResolver
}

// NewScopedTokenAuthorizer 创建不额外缓存租约绑定的鉴权策略。
func NewScopedTokenAuthorizer(
	tokens TokenResolver,
) (*ScopedTokenAuthorizer, error) {
	if tokens == nil {
		return nil, ErrInvalidAuthorizer
	}
	return &ScopedTokenAuthorizer{tokens: tokens}, nil
}

// Authorize 只接受一个格式明确的 Relay Token，并返回其服务端绑定。
func (authorizer *ScopedTokenAuthorizer) Authorize(
	request *http.Request,
) (accountcore.AccountRef, runtimecore.ModelID, bool) {
	if authorizer == nil || authorizer.tokens == nil || request == nil {
		return "", "", false
	}
	values := request.Header.Values(RelayTokenHeader)
	if len(values) != 1 || !validRelayToken(values[0]) {
		return "", "", false
	}
	accountRef, modelID, found := authorizer.tokens.ConsumeRelayToken(values[0])
	return accountRef,
		modelID,
		found && accountRef.IsValid() && modelID.IsValid()
}

// validRelayToken 拒绝空白、控制字符和异常长度，避免 Header 歧义。
func validRelayToken(token string) bool {
	return len(token) >= minRelayTokenSize &&
		len(token) <= maxRelayTokenSize &&
		strings.TrimSpace(token) == token &&
		!strings.ContainsAny(token, " \t\r\n")
}
