package zcodeoauth

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

// ZCode 官方的服务端中介授权（旧 Node 的 cli-flow）：
//
//  1. POST /api/v1/oauth/cli/init（Bearer 随机 poll_token，body {provider}）
//     → flow_id / authorize_url / expires_at / poll_interval_sec；
//  2. 用户在任意设备打开 authorize_url，回调落到 zcode.z.ai 自己的 HTTPS 地址；
//  3. aih 轮询 /api/v1/oauth/cli/poll/<flow_id> 取回 token。
//
// 不需要本机回调地址、不需要 zcode:// 协议处理器，也不需要本机浏览器。
const (
	cliAPIBase             = "https://zcode.z.ai/api/v1"
	cliPollTokenBytes      = 32
	cliDefaultPollInterval = 2 * time.Second
	cliMinPollInterval     = time.Second
	cliMaxPollInterval     = 30 * time.Second
	// cliInvalidFlowCode 表示 flow 不存在/已过期/poll_token 不匹配。
	cliInvalidFlowCode = 3004
	maxCLIBodyBytes    = 64 * 1024
)

type cliEnvelope struct {
	Code *int            `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

type cliInitData struct {
	FlowID          string  `json:"flow_id"`
	AuthorizeURL    string  `json:"authorize_url"`
	ExpiresAt       int64   `json:"expires_at"`
	PollIntervalSec float64 `json:"poll_interval_sec"`
}

type cliPollData struct {
	Status string `json:"status"`
	tokenData
}

type cliFlow struct {
	client        *http.Client
	baseURL       string
	region        region
	strategy      string
	flowID        string
	pollToken     string
	authorization string
	state         string
	expiresAt     time.Time
	interval      time.Duration
	account       accountauth.Account
}

// beginCLIFlow 发起服务端中介授权。
func (provider *Provider) beginCLIFlow(
	ctx context.Context,
	selected region,
	strategy string,
) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	tokenBytes := make([]byte, cliPollTokenBytes)
	if _, err := io.ReadFull(provider.random, tokenBytes); err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	pollToken := hex.EncodeToString(tokenBytes)
	payload, err := json.Marshal(map[string]string{"provider": selected.id})
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	baseURL := strings.TrimRight(strings.TrimSpace(provider.cliBaseURL), "/")
	if baseURL == "" {
		baseURL = cliAPIBase
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		baseURL+"/oauth/cli/init",
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+pollToken)
	response, err := provider.client.Do(request)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 400 && response.StatusCode < 500 {
			return nil, accountauth.ErrProviderRejected
		}
		return nil, accountauth.ErrProviderUnavailable
	}
	var envelope cliEnvelope
	if err := oauthutil.DecodeJSONResponse(response.Body, maxCLIBodyBytes, &envelope); err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	if envelope.Code != nil && *envelope.Code != 0 {
		return nil, accountauth.ErrProviderRejected
	}
	var data cliInitData
	if len(envelope.Data) == 0 || json.Unmarshal(envelope.Data, &data) != nil {
		return nil, accountauth.ErrProviderRejected
	}
	flowID := strings.TrimSpace(data.FlowID)
	authorizeURL := strings.TrimSpace(data.AuthorizeURL)
	expiresAt := time.Unix(data.ExpiresAt, 0)
	if flowID == "" || !validAbsoluteURL(authorizeURL) || !expiresAt.After(time.Now()) {
		return nil, accountauth.ErrProviderUnavailable
	}
	interval := time.Duration(data.PollIntervalSec * float64(time.Second))
	if interval <= 0 {
		interval = cliDefaultPollInterval
	}
	if interval < cliMinPollInterval {
		interval = cliMinPollInterval
	}
	if interval > cliMaxPollInterval {
		interval = cliMaxPollInterval
	}
	state := ""
	if parsed, parseErr := url.Parse(authorizeURL); parseErr == nil {
		state = strings.TrimSpace(parsed.Query().Get("state"))
	}
	return &cliFlow{
		client:        provider.client,
		baseURL:       baseURL,
		region:        selected,
		strategy:      strategy,
		flowID:        flowID,
		pollToken:     pollToken,
		authorization: authorizeURL,
		state:         state,
		expiresAt:     expiresAt,
		interval:      interval,
	}, nil
}

func (flow *cliFlow) AuthorizationURL() string { return flow.authorization }

func (flow *cliFlow) OAuthState() string { return flow.state }

func (flow *cliFlow) AuthStrategy() string { return flow.strategy }

// AuthMode 让 WebUI 走「授权链接」卡片；服务端仍按 DeviceFlow 轮询上游。
func (flow *cliFlow) AuthMode() string { return "oauth-browser" }

func (flow *cliFlow) AccountClaims() accountauth.Account { return flow.account }

func (flow *cliFlow) PollInterval() time.Duration {
	if flow.interval <= 0 {
		return cliDefaultPollInterval
	}
	return flow.interval
}

// Exchange 只满足 OAuthFlow 端口；服务端中介流程由 Poll 驱动。
func (flow *cliFlow) Exchange(context.Context, string) ([]byte, error) {
	return nil, accountauth.ErrInvalidCallback
}

func (flow *cliFlow) Poll(ctx context.Context) (accountauth.DevicePoll, error) {
	if !flow.expiresAt.IsZero() && !time.Now().Before(flow.expiresAt) {
		return accountauth.DevicePoll{Status: accountauth.DeviceExpired}, nil
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		flow.baseURL+"/oauth/cli/poll/"+url.PathEscape(flow.flowID),
		nil,
	)
	if err != nil {
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+flow.pollToken)
	response, err := flow.client.Do(request)
	if err != nil {
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	switch {
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusRequestTimeout:
		next := flow.PollInterval() * 2
		if next > cliMaxPollInterval {
			next = cliMaxPollInterval
		}
		return accountauth.DevicePoll{Status: accountauth.DeviceSlowDown, Interval: next}, nil
	case response.StatusCode >= 400 && response.StatusCode < 500:
		return accountauth.DevicePoll{Status: accountauth.DeviceExpired}, nil
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
	var envelope cliEnvelope
	if err := oauthutil.DecodeJSONResponse(response.Body, maxCLIBodyBytes, &envelope); err != nil {
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
	if envelope.Code != nil {
		if *envelope.Code == cliInvalidFlowCode {
			return accountauth.DevicePoll{Status: accountauth.DeviceExpired}, nil
		}
		if *envelope.Code != 0 {
			return accountauth.DevicePoll{}, accountauth.ErrProviderRejected
		}
	}
	var data cliPollData
	if len(envelope.Data) == 0 || json.Unmarshal(envelope.Data, &data) != nil {
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
	switch strings.ToLower(strings.TrimSpace(data.Status)) {
	case "pending":
		return accountauth.DevicePoll{Status: accountauth.DevicePending}, nil
	case "failed":
		return accountauth.DevicePoll{Status: accountauth.DeviceFailed}, nil
	case "ready":
		return flow.readyPoll(data)
	default:
		return accountauth.DevicePoll{}, accountauth.ErrProviderUnavailable
	}
}

func (flow *cliFlow) readyPoll(data cliPollData) (accountauth.DevicePoll, error) {
	tokens := providerTokensOf(data.tokenData, flow.region.id)
	zcodeJWToken := strings.TrimSpace(data.Token)
	if tokens == nil {
		return accountauth.DevicePoll{}, accountauth.ErrProviderRejected
	}
	accessToken := tokens.accessToken()
	if !validSecret(accessToken) || !validSecret(zcodeJWToken) {
		return accountauth.DevicePoll{}, accountauth.ErrProviderRejected
	}
	result := exchangeResult{
		accessToken:  accessToken,
		refreshToken: tokens.refreshTokenValue(),
		zcodeJWToken: zcodeJWToken,
		user:         decodeUser(data.User),
	}
	artifacts, account, err := buildZcodeArtifacts(flow.region, result)
	if err != nil {
		return accountauth.DevicePoll{}, err
	}
	flow.account = account
	return accountauth.DevicePoll{
		Status:    accountauth.DeviceReady,
		Artifacts: artifacts,
		Account:   account,
	}, nil
}
