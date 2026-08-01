package providercli

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const pinnedAccountHeader = "X-Account-Ref"

// claudeGatewayProxy 把固定账号约束绑定在本地进程边界，避免共享 settings 覆盖 Header。
type claudeGatewayProxy struct {
	target      *url.URL
	clientKey   string
	accountRef  accountcore.AccountRef
	localSecret string
	client      *http.Client
}

// runClaudePinnedGateway 用随机本地 Key 隔离真实 Server Key 并强制固定账号。
func (runner *Runner) runClaudePinnedGateway(
	ctx context.Context,
	spec providerlaunch.GatewayLaunchSpec,
	arguments []string,
) error {
	accountRef, pinned := spec.PinnedAccount()
	values := spec.Environment().RevealSet()
	if !pinned || values["ANTHROPIC_BASE_URL"] == "" || values["ANTHROPIC_API_KEY"] == "" {
		return ErrInvalidRunRequest
	}
	target, err := url.Parse(values["ANTHROPIC_BASE_URL"])
	if err != nil {
		return err
	}
	localSecret, err := newLocalProxySecret()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	proxy := &claudeGatewayProxy{
		target:      target,
		clientKey:   values["ANTHROPIC_API_KEY"],
		accountRef:  accountRef,
		localSecret: localSecret,
		client:      runner.httpClient,
	}
	environment := applyEnvironment(runner.environ(), spec.Environment())
	environment = unsetEnvironmentValue(environment, "ANTHROPIC_CUSTOM_HEADERS")
	environment = setEnvironmentValue(environment, "ANTHROPIC_API_KEY", localSecret)
	environment = setEnvironmentValue(
		environment,
		"ANTHROPIC_BASE_URL",
		"http://"+listener.Addr().String(),
	)
	return runner.runWithHTTPProxy(
		ctx,
		listener,
		proxy,
		spec.ProviderID(),
		spec.Binary(),
		arguments,
		environment,
	)
}

// ServeHTTP 校验随机本地 Key，覆盖伪造 Header 后转发到 AIH Server。
func (proxy *claudeGatewayProxy) ServeHTTP(writer http.ResponseWriter, incoming *http.Request) {
	if !constantTimeEqual(incoming.Header.Get("x-api-key"), proxy.localSecret) {
		writeProxyError(writer, http.StatusUnauthorized, "local proxy authentication failed")
		return
	}
	body, err := readReplayableBody(incoming)
	if err != nil {
		writeProxyError(writer, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}
	request, err := newForwardRequest(incoming.Context(), incoming, proxy.target, body)
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "gateway request build failed")
		return
	}
	request.Header.Del("Authorization")
	request.Header.Del("x-api-key")
	request.Header.Del(pinnedAccountHeader)
	request.Header.Set("x-api-key", proxy.clientKey)
	request.Header.Set(pinnedAccountHeader, proxy.accountRef.String())
	response, err := proxy.client.Do(request)
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "gateway request failed")
		return
	}
	writeForwardResponse(writer, response)
}

// newLocalProxySecret 生成只存在于单次父子进程环境的高熵本地密钥。
func newLocalProxySecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

// constantTimeEqual 使用固定长度摘要比较本地密钥，避免长度和前缀时序泄漏。
func constantTimeEqual(left string, right string) bool {
	leftDigest := sha256.Sum256([]byte(left))
	rightDigest := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(leftDigest[:], rightDigest[:]) == 1
}
