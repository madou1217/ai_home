package providercli

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	pinnedAccountHeader        = "X-Account-Ref"
	claudeRelayTokenHeader     = "X-AIH-Relay-Token"
	claudeRelayLeasePath       = "/v1/claude-relay-leases"
	maxClaudeRelayLeaseBytes   = 16 * 1024
	unsupportedRelayCredential = "unsupported_relay_credential"
)

var errClaudeRelayLease = errors.New("Claude Gateway Relay 租约失败")

// claudeGatewayProxy 把固定账号约束绑定在本地进程边界，避免共享 settings 覆盖 Header。
type claudeGatewayProxy struct {
	target      *url.URL
	clientKey   string
	relayToken  string
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
	relayToken, err := issueClaudeRelayLease(
		ctx,
		runner.httpClient,
		target,
		values["ANTHROPIC_API_KEY"],
		accountRef,
	)
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
		relayToken:  relayToken,
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
		spec.ClientProviderID(),
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
	proxy.projectServerAuthorization(request.Header)
	response, err := proxy.client.Do(request)
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "gateway request failed")
		return
	}
	writeForwardResponse(writer, response)
}

// projectServerAuthorization 根据服务端确认的凭据类型选择互斥传输合同。
// OAuth 使用账号绑定租约进入 Native Relay；其他凭据继续使用 Canonical API。
func (proxy *claudeGatewayProxy) projectServerAuthorization(header http.Header) {
	header.Del("Authorization")
	header.Del("x-api-key")
	header.Del(pinnedAccountHeader)
	header.Del(claudeRelayTokenHeader)
	if proxy.relayToken != "" {
		header.Set(claudeRelayTokenHeader, proxy.relayToken)
		return
	}
	header.Set("x-api-key", proxy.clientKey)
	header.Set(pinnedAccountHeader, proxy.accountRef.String())
}

// issueClaudeRelayLease 让 Server 以当前账号真实凭据选择传输方式。
// 非 OAuth 账号以明确 422 回到 Canonical；其他失败一律关闭而不猜测。
func issueClaudeRelayLease(
	ctx context.Context,
	client *http.Client,
	target *url.URL,
	clientKey string,
	accountRef accountcore.AccountRef,
) (string, error) {
	if ctx == nil || client == nil || target == nil || clientKey == "" ||
		!accountRef.IsValid() {
		return "", errClaudeRelayLease
	}
	payload, err := json.Marshal(map[string]string{
		"account_ref": accountRef.String(),
	})
	if err != nil {
		return "", errClaudeRelayLease
	}
	leaseURL := *target
	leaseURL.Path = joinURLPath(target.Path, claudeRelayLeasePath)
	leaseURL.RawPath = ""
	leaseURL.RawQuery = ""
	leaseURL.Fragment = ""
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		leaseURL.String(),
		bytes.NewReader(payload),
	)
	if err != nil {
		return "", errClaudeRelayLease
	}
	request.Header.Set("Authorization", "Bearer "+clientKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	noRedirectClient := *client
	noRedirectClient.CheckRedirect = func(
		_ *http.Request,
		_ []*http.Request,
	) error {
		return http.ErrUseLastResponse
	}
	response, err := noRedirectClient.Do(request)
	if err != nil || response == nil || response.Body == nil {
		closeProviderResponse(response)
		return "", errClaudeRelayLease
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(
		response.Body,
		maxClaudeRelayLeaseBytes+1,
	))
	if err != nil || len(body) > maxClaudeRelayLeaseBytes {
		return "", errClaudeRelayLease
	}
	if response.StatusCode == http.StatusUnprocessableEntity {
		var document claudeRelayLeaseError
		if json.Unmarshal(body, &document) == nil &&
			document.Error.Code == unsupportedRelayCredential {
			return "", nil
		}
		return "", errClaudeRelayLease
	}
	if response.StatusCode != http.StatusCreated {
		return "", errClaudeRelayLease
	}
	var document claudeRelayLeaseResponse
	if json.Unmarshal(body, &document) != nil ||
		document.Data.AccountRef != accountRef.String() ||
		!validClaudeRelayToken(document.Data.Token) {
		return "", errClaudeRelayLease
	}
	return document.Data.Token, nil
}

// validClaudeRelayToken 拒绝无法安全进入单值 Header 的服务端响应。
func validClaudeRelayToken(token string) bool {
	return len(token) >= 16 &&
		len(token) <= 512 &&
		strings.TrimSpace(token) == token &&
		!strings.ContainsAny(token, " \t\r\n")
}

// closeProviderResponse 关闭网络错误同时返回的非空响应。
func closeProviderResponse(response *http.Response) {
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
}

// claudeRelayLeaseResponse 是租约入口的最小成功投影。
type claudeRelayLeaseResponse struct {
	Data struct {
		Token      string `json:"token"`
		AccountRef string `json:"account_ref"`
	} `json:"data"`
}

// claudeRelayLeaseError 是可安全用于传输选择的稳定错误码投影。
type claudeRelayLeaseError struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
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
