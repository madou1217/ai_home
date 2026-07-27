package accountsapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"
)

// ErrInvalidAuthorizer 表示 HTTP Handler 缺少可用的管理鉴权依赖。
var ErrInvalidAuthorizer = errors.New("账号 HTTP 管理鉴权无效")

// Authorizer 是账号管理 HTTP 入站请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ManagementKeyProvider 返回当前生效的 Management Key。
//
// 使用函数而不是固定字符串，允许 Composition Root 热更新密钥而不重建 Handler。
type ManagementKeyProvider func() string

// BearerAuthorizer 使用常量时间摘要比较校验 Management Key。
type BearerAuthorizer struct {
	managementKey ManagementKeyProvider
}

// NewBearerAuthorizer 创建不会长期复制明文 Management Key 的鉴权策略。
func NewBearerAuthorizer(
	managementKey ManagementKeyProvider,
) (*BearerAuthorizer, error) {
	if managementKey == nil {
		return nil, ErrInvalidAuthorizer
	}
	return &BearerAuthorizer{managementKey: managementKey}, nil
}

// Authorized 校验标准 Authorization Bearer 请求头。
func (authorizer *BearerAuthorizer) Authorized(request *http.Request) bool {
	if authorizer == nil || authorizer.managementKey == nil || request == nil {
		return false
	}
	expected := authorizer.managementKey()
	authorizationHeaders := request.Header.Values("Authorization")
	if len(authorizationHeaders) != 1 {
		return false
	}
	provided, found := parseBearerToken(authorizationHeaders[0])
	if !found || expected == "" {
		return false
	}
	expectedDigest := sha256.Sum256([]byte(expected))
	providedDigest := sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(
		expectedDigest[:],
		providedDigest[:],
	) == 1
}

// parseBearerToken 只接受单个不含空白字符的 Bearer Token。
func parseBearerToken(header string) (string, bool) {
	scheme, token, found := strings.Cut(header, " ")
	if !found ||
		!strings.EqualFold(scheme, "Bearer") ||
		token == "" ||
		strings.ContainsAny(token, " \t\r\n") {
		return "", false
	}
	return token, true
}
