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
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
)

const (
	pinnedAccountHeader          = "X-Account-Ref"
	claudeRelayTokenHeader       = "X-AIH-Relay-Token"
	maxClaudeRelaySelectionBytes = 16 * 1024
	maxClaudeGatewayAttempts     = 4
)

var errClaudeGatewaySelection = errors.New("Claude Gateway 账号选择失败")

// claudeGatewayProxy 在本地进程边界隔离 Server Key，并执行请求级账号选择。
type claudeGatewayProxy struct {
	target      *url.URL
	clientKey   string
	accountRef  accountcore.AccountRef
	localSecret string
	client      *http.Client
}

// runClaudeGateway 用随机本地 Key 隔离真实 Server Key，并让 Server 按模型征召账号。
func (runner *Runner) runClaudeGateway(
	ctx context.Context,
	spec providerlaunch.GatewayLaunchSpec,
	arguments []string,
) error {
	accountRef, pinned := spec.PinnedAccount()
	values := spec.Environment().RevealSet()
	if values["ANTHROPIC_BASE_URL"] == "" || values["ANTHROPIC_API_KEY"] == "" ||
		(pinned && !accountRef.IsValid()) {
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
		spec.ClientProviderID(),
		spec.Binary(),
		arguments,
		environment,
	)
}

// ServeHTTP 校验随机本地 Key，并按正文真实模型执行 Server 的稳定传输决策。
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
	if incoming.URL.Path != "/v1/messages" || incoming.Method != http.MethodPost {
		proxy.forwardNonMessage(writer, incoming, body)
		return
	}
	model, err := claudeRequestModel(body)
	if err != nil {
		writeProxyError(writer, http.StatusBadRequest, "invalid Claude model")
		return
	}
	attemptedAccounts := make(
		[]accountcore.AccountRef,
		0,
		maxClaudeGatewayAttempts,
	)
	decision, selectErr := selectClaudeGatewayTransport(
		incoming.Context(),
		proxy.client,
		proxy.target,
		proxy.clientKey,
		model,
		proxy.accountRef,
		attemptedAccounts,
	)
	if selectErr != nil {
		writeProxyError(writer, http.StatusServiceUnavailable, "no Claude account is available")
		return
	}
	for attempt := 0; attempt < maxClaudeGatewayAttempts; attempt++ {
		if containsAccountRef(attemptedAccounts, decision.accountRef) {
			writeProxyError(writer, http.StatusBadGateway, "gateway selected a repeated account")
			return
		}
		attemptedAccounts = append(attemptedAccounts, decision.accountRef)
		request, buildErr := newForwardRequest(
			incoming.Context(),
			incoming,
			proxy.target,
			body,
		)
		if buildErr != nil {
			writeProxyError(writer, http.StatusBadGateway, "gateway request build failed")
			return
		}
		if projectErr := proxy.projectServerAuthorization(
			request.Header,
			decision,
		); projectErr != nil {
			writeProxyError(writer, http.StatusBadGateway, "invalid gateway transport")
			return
		}
		response, forwardErr := proxy.client.Do(request)
		if forwardErr != nil {
			closeProviderResponse(response)
			writeProxyError(writer, http.StatusBadGateway, "gateway request failed")
			return
		}
		retry := shouldRetryClaudeAccount(response) &&
			!proxy.accountRef.IsValid() &&
			attempt+1 < maxClaudeGatewayAttempts
		response.Header.Del(gatewaycontract.RetryAccountHeader)
		if retry {
			nextDecision, nextErr := selectClaudeGatewayTransport(
				incoming.Context(),
				proxy.client,
				proxy.target,
				proxy.clientKey,
				model,
				proxy.accountRef,
				attemptedAccounts,
			)
			if nextErr != nil {
				// 没有下一账号时保留最后一个真实上游错误，避免伪造 503。
				writeForwardResponse(writer, response)
				return
			}
			if containsAccountRef(attemptedAccounts, nextDecision.accountRef) {
				closeProviderResponse(response)
				writeProxyError(writer, http.StatusBadGateway, "gateway selected a repeated account")
				return
			}
			closeProviderResponse(response)
			decision = nextDecision
			continue
		}
		writeForwardResponse(writer, response)
		return
	}
	writeProxyError(writer, http.StatusServiceUnavailable, "no Claude account is available")
}

// forwardNonMessage 保持未知路径由 Server 统一返回合同错误，不参与账号征召。
func (proxy *claudeGatewayProxy) forwardNonMessage(
	writer http.ResponseWriter,
	incoming *http.Request,
	body []byte,
) {
	request, err := newForwardRequest(incoming.Context(), incoming, proxy.target, body)
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "gateway request build failed")
		return
	}
	request.Header.Del("Authorization")
	request.Header.Set("x-api-key", proxy.clientKey)
	request.Header.Del(claudeRelayTokenHeader)
	request.Header.Del(pinnedAccountHeader)
	if proxy.accountRef.IsValid() {
		request.Header.Set(pinnedAccountHeader, proxy.accountRef.String())
	}
	response, err := proxy.client.Do(request)
	if err != nil {
		closeProviderResponse(response)
		writeProxyError(writer, http.StatusBadGateway, "gateway request failed")
		return
	}
	response.Header.Del(gatewaycontract.RetryAccountHeader)
	writeForwardResponse(writer, response)
}

// projectServerAuthorization 根据 Server 决策选择互斥传输合同。
func (proxy *claudeGatewayProxy) projectServerAuthorization(
	header http.Header,
	decision claudeGatewayDecision,
) error {
	header.Del("Authorization")
	header.Del("x-api-key")
	header.Del(pinnedAccountHeader)
	header.Del(claudeRelayTokenHeader)
	switch decision.transport {
	case gatewaycontract.TransportNativeOAuth:
		header.Set(claudeRelayTokenHeader, decision.relayToken)
	case gatewaycontract.TransportCanonical:
		header.Set("x-api-key", proxy.clientKey)
		header.Set(pinnedAccountHeader, decision.accountRef.String())
	default:
		return errClaudeGatewaySelection
	}
	return nil
}

// selectClaudeGatewayTransport 让 Server 按模型、运行态和公平票号选择账号。
func selectClaudeGatewayTransport(
	ctx context.Context,
	client *http.Client,
	target *url.URL,
	clientKey string,
	model string,
	accountRef accountcore.AccountRef,
	excludedAccounts []accountcore.AccountRef,
) (claudeGatewayDecision, error) {
	if ctx == nil || client == nil || target == nil || clientKey == "" ||
		model == "" || (accountRef != "" && !accountRef.IsValid()) ||
		len(excludedAccounts) > maxClaudeGatewayAttempts ||
		(accountRef.IsValid() && len(excludedAccounts) > 0) {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	excluded := make([]string, 0, len(excludedAccounts))
	for index, excludedAccount := range excludedAccounts {
		if !excludedAccount.IsValid() ||
			containsAccountRef(excludedAccounts[:index], excludedAccount) {
			return claudeGatewayDecision{}, errClaudeGatewaySelection
		}
		excluded = append(excluded, excludedAccount.String())
	}
	payload, err := json.Marshal(gatewaycontract.SelectionRequest{
		Model:               model,
		AccountRef:          accountRef.String(),
		ExcludedAccountRefs: excluded,
	})
	if err != nil {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	leaseURL := *target
	leaseURL.Path = joinURLPath(target.Path, gatewaycontract.SelectionPath)
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
		return claudeGatewayDecision{}, errClaudeGatewaySelection
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
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(
		response.Body,
		maxClaudeRelaySelectionBytes+1,
	))
	if err != nil || len(body) > maxClaudeRelaySelectionBytes {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	if response.StatusCode != http.StatusCreated {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	var document gatewaycontract.SelectionResponse
	if json.Unmarshal(body, &document) != nil {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	selectedAccount, err := accountcore.ParseAccountRef(document.Data.AccountRef)
	if err != nil || (accountRef.IsValid() && selectedAccount != accountRef) {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	decision := claudeGatewayDecision{
		transport:  document.Data.Transport,
		accountRef: selectedAccount,
		relayToken: document.Data.Token,
	}
	if !decision.IsValid() {
		return claudeGatewayDecision{}, errClaudeGatewaySelection
	}
	return decision, nil
}

// containsAccountRef 在线性固定上限切片中检查同一请求是否已经调用过账号。
func containsAccountRef(
	accounts []accountcore.AccountRef,
	target accountcore.AccountRef,
) bool {
	for _, accountRef := range accounts {
		if accountRef == target {
			return true
		}
	}
	return false
}

// claudeGatewayDecision 是代理内存中的最小传输投影。
type claudeGatewayDecision struct {
	transport  string
	accountRef accountcore.AccountRef
	relayToken string
}

// IsValid 校验 Canonical 与 Native OAuth Header 所需字段互斥。
func (decision claudeGatewayDecision) IsValid() bool {
	if !decision.accountRef.IsValid() {
		return false
	}
	switch decision.transport {
	case gatewaycontract.TransportCanonical:
		return decision.relayToken == ""
	case gatewaycontract.TransportNativeOAuth:
		return validClaudeRelayToken(decision.relayToken)
	default:
		return false
	}
}

// claudeRequestModel 只读取顶层 model，不重编码或修改 Claude Code 原始请求。
func claudeRequestModel(body []byte) (string, error) {
	var envelope struct {
		Model string `json:"model"`
	}
	if len(body) == 0 || json.Unmarshal(body, &envelope) != nil ||
		envelope.Model == "" || envelope.Model != strings.TrimSpace(envelope.Model) ||
		strings.ContainsRune(envelope.Model, '\x00') {
		return "", ErrInvalidRunRequest
	}
	return envelope.Model, nil
}

// shouldRetryClaudeAccount 只相信 Server 在响应提交前生成的显式换号标记。
func shouldRetryClaudeAccount(response *http.Response) bool {
	return response != nil && response.Header.Get(
		gatewaycontract.RetryAccountHeader,
	) == gatewaycontract.RetryAccountValue
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
