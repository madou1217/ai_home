package claudenativerelay

import (
	"errors"
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// RelayTokenHeader 携带只绑定一个 AccountRef 的本地短期 Relay Token。
	RelayTokenHeader  = "X-AIH-Relay-Token"
	minRelayTokenSize = 16
	maxRelayTokenSize = 512
)

// ErrInvalidAuthorizer 表示 Relay Token 解析端口缺失。
var ErrInvalidAuthorizer = errors.New("Claude Native Relay 鉴权依赖无效")

// TokenResolver 把不透明短期 Token 解析为唯一可信 AccountRef。
//
// 该端口应由未来的会话租约注册表实现；Handler 不接受客户端自报的 AccountRef。
type TokenResolver interface {
	ResolveRelayToken(token string) (accountcore.AccountRef, bool)
}

// ScopedTokenAuthorizer 使用短期 Token 得到服务端绑定的账号身份。
type ScopedTokenAuthorizer struct {
	tokens TokenResolver
}

// NewScopedTokenAuthorizer 创建不缓存 Token 或 AccountRef 的鉴权策略。
func NewScopedTokenAuthorizer(
	tokens TokenResolver,
) (*ScopedTokenAuthorizer, error) {
	if tokens == nil {
		return nil, ErrInvalidAuthorizer
	}
	return &ScopedTokenAuthorizer{tokens: tokens}, nil
}

// Authorize 只接受一个格式明确的 Relay Token，并返回其服务端绑定身份。
func (authorizer *ScopedTokenAuthorizer) Authorize(
	request *http.Request,
) (accountcore.AccountRef, bool) {
	if authorizer == nil || authorizer.tokens == nil || request == nil {
		return "", false
	}
	values := request.Header.Values(RelayTokenHeader)
	if len(values) != 1 || !validRelayToken(values[0]) {
		return "", false
	}
	accountRef, found := authorizer.tokens.ResolveRelayToken(values[0])
	return accountRef, found && accountRef.IsValid()
}

// validRelayToken 拒绝空白、控制字符和异常长度，避免 Header 歧义。
func validRelayToken(token string) bool {
	return len(token) >= minRelayTokenSize &&
		len(token) <= maxRelayTokenSize &&
		strings.TrimSpace(token) == token &&
		!strings.ContainsAny(token, " \t\r\n")
}
