package opencodeoauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

// PollStatus 直接复用应用层的设备码词汇：Job 编排只认 accountauth.DevicePoll，
// 适配器内保留短名便于表达轮询分支。
type PollStatus = accountauth.DeviceStatus

const (
	// PollPending 表示用户还没完成授权。
	PollPending = accountauth.DevicePending
	// PollSlowDown 表示轮询过快，应按 Interval 退避。
	PollSlowDown = accountauth.DeviceSlowDown
	// PollReady 表示授权完成，Artifacts 可交给账号注册链。
	PollReady = accountauth.DeviceReady
	// PollFailed 表示上游明确拒绝（access_denied 等）。
	PollFailed = accountauth.DeviceFailed
	// PollExpired 表示设备码已过期，需要重新发起。
	PollExpired = accountauth.DeviceExpired
)

// PollResult 是一次轮询的结果（与应用层 DevicePoll 同构）。
type PollResult = accountauth.DevicePoll

// ErrAuthorizationPending 表示设备授权尚未完成（Exchange 单次轮询的返回值）。
var ErrAuthorizationPending = errors.New("OpenCode 设备授权尚未完成")

// ErrSlowDown 表示轮询过快（Exchange 单次轮询的返回值）。
var ErrSlowDown = errors.New("OpenCode 设备授权轮询过快")

// flow 私有持有一次设备码会话。
type flow struct {
	client        *http.Client
	clock         Clock
	server        string
	deviceCode    string
	userCode      string
	authorization string
	expiresAt     time.Time
	interval      time.Duration
	// terminal 缓存终态：轮询是幂等的，重复 Poll 不再打上游。
	terminal *PollResult
	// claims 是 ready 时从 Console 身份派生的公开账号字段。
	claims accountauth.Account
}

// AuthorizationURL 返回浏览器验证地址（verification_uri_complete）。
func (flow *flow) AuthorizationURL() string {
	return flow.authorization
}

// AccountClaims 返回 ready 之后可直接展示的公开账号字段。
func (flow *flow) AccountClaims() accountauth.Account {
	if flow == nil {
		return accountauth.Account{}
	}
	return flow.claims
}

// UserCode 返回需要用户核对/输入的设备码。
func (flow *flow) UserCode() string {
	return flow.userCode
}

// PollInterval 返回当前建议的轮询间隔。
func (flow *flow) PollInterval() time.Duration {
	return flow.interval
}

// ExpiresAt 返回设备码的绝对过期时间。
func (flow *flow) ExpiresAt() time.Time {
	return flow.expiresAt
}

// Exchange 执行一次轮询，供只认 Exchange 的调用方使用。
//
// 设备码流程没有回调：Job 框架应当按 PollInterval 反复调用 Poll；
// Exchange 只是让 Flow 满足 OAuthFlow 端口，pending/slow_down 用可识别的
// 哨兵错误返回，不能当成终态失败。
func (flow *flow) Exchange(ctx context.Context, _ string) ([]byte, error) {
	result, err := flow.Poll(ctx)
	if err != nil {
		return nil, err
	}
	switch result.Status {
	case PollReady:
		return result.Artifacts, nil
	case PollPending:
		return nil, ErrAuthorizationPending
	case PollSlowDown:
		return nil, ErrSlowDown
	default:
		return nil, accountauth.ErrProviderRejected
	}
}

// Poll 执行一次设备码轮询。
//
// 正常返回只包含 pending / slow_down / ready / failed / expired；网络与 5xx
// 以 accountauth.ErrProviderUnavailable 返回，由调用方决定是否重试。
func (flow *flow) Poll(ctx context.Context) (PollResult, error) {
	if flow == nil {
		return PollResult{}, accountauth.ErrInvalidDependencies
	}
	if flow.terminal != nil {
		return *flow.terminal, nil
	}
	if !flow.clock().UTC().Before(flow.expiresAt) {
		return flow.finish(PollResult{Status: PollExpired}), nil
	}
	response, err := postJSON(ctx, flow.client, flow.server+deviceTokenPath, map[string]any{
		"grant_type":  deviceGrantType,
		"device_code": flow.deviceCode,
		"client_id":   clientID,
	})
	if err != nil {
		return PollResult{}, err
	}
	defer response.close()
	// 408/429 是「先别问」，与 slow_down 等价。
	if response.status == http.StatusRequestTimeout || response.status == http.StatusTooManyRequests {
		return flow.slowDown(), nil
	}
	if response.status >= 400 && response.status < 500 {
		return flow.handleDeviceError(response), nil
	}
	var payload deviceTokenPayload
	if err := decodePayload(response, &payload); err != nil {
		return PollResult{}, err
	}
	if !validSecret(payload.AccessToken) ||
		!validSecret(payload.RefreshToken) ||
		payload.ExpiresIn <= 0 {
		return PollResult{}, accountauth.ErrProviderRejected
	}
	return flow.materialize(ctx, payload)
}

// deviceTokenPayload 是设备码轮询的成功响应。
type deviceTokenPayload struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	OrgID        string `json:"org_id"`
}

// deviceError 是设备码轮询的业务错误体。
type deviceError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// handleDeviceError 把 4xx 业务错误归一成轮询状态。
func (flow *flow) handleDeviceError(response *httpResponse) PollResult {
	var failure deviceError
	if err := oauthutil.DecodeJSONResponse(response.body, maxBodyBytes, &failure); err != nil {
		// 4xx 却读不出业务错误：上游合同已经异常，按失败收敛，避免无限轮询。
		return flow.finish(PollResult{Status: PollFailed})
	}
	switch strings.ToLower(strings.TrimSpace(failure.Error)) {
	case "authorization_pending":
		return PollResult{Status: PollPending, Interval: flow.interval}
	case "slow_down":
		return flow.slowDown()
	case "expired_token":
		return flow.finish(PollResult{Status: PollExpired})
	default:
		return flow.finish(PollResult{Status: PollFailed})
	}
}

// slowDown 按官方 CLI 的步长拉长轮询间隔。
func (flow *flow) slowDown() PollResult {
	flow.interval += slowDownStep
	if flow.interval > 30*time.Second {
		flow.interval = 30 * time.Second
	}
	return PollResult{Status: PollSlowDown, Interval: flow.interval}
}

// finish 记录终态并释放一次性设备码。
func (flow *flow) finish(result PollResult) PollResult {
	flow.terminal = &result
	flow.deviceCode = ""
	return result
}

// materialize 用 access token 补齐身份，并生成可注册的 native_auth_json。
func (flow *flow) materialize(
	ctx context.Context,
	payload deviceTokenPayload,
) (PollResult, error) {
	user, err := flow.fetchUser(ctx, payload.AccessToken)
	if err != nil {
		return PollResult{}, err
	}
	orgs, err := flow.fetchOrgs(ctx, payload.AccessToken)
	if err != nil {
		return PollResult{}, err
	}
	organization := selectOrganization(orgs, payload.OrgID)
	if payload.OrgID != "" && organization == nil {
		// 上游指定了 org 但列表里没有：不写半截身份。
		return PollResult{}, accountauth.ErrProviderRejected
	}
	artifacts, err := buildArtifacts(flow.server, payload, user, organization, flow.clock().UTC())
	if err != nil {
		return PollResult{}, err
	}
	flow.claims = accountauth.Account{Email: user.Email, DisplayName: user.Email}
	return flow.finish(PollResult{
		Status:    PollReady,
		Artifacts: artifacts,
		Account:   flow.claims,
	}), nil
}

// consoleUser 是 /api/user 的公开身份。
type consoleUser struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// consoleOrg 是 /api/orgs 的组织条目。
type consoleOrg struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// fetchUser 读取 Console 账号身份。
func (flow *flow) fetchUser(ctx context.Context, accessToken string) (consoleUser, error) {
	var user consoleUser
	if err := flow.getJSON(ctx, userPath, accessToken, &user); err != nil {
		return consoleUser{}, err
	}
	if !validSecret(user.ID) {
		return consoleUser{}, accountauth.ErrProviderRejected
	}
	return user, nil
}

// fetchOrgs 读取组织列表；空列表是合法结果（个人号可以没有组织）。
func (flow *flow) fetchOrgs(ctx context.Context, accessToken string) ([]consoleOrg, error) {
	var orgs []consoleOrg
	if err := flow.getJSON(ctx, orgsPath, accessToken, &orgs); err != nil {
		return nil, err
	}
	return orgs, nil
}

// getJSON 用 Bearer 凭据读取 Console 接口。
func (flow *flow) getJSON(
	ctx context.Context,
	path string,
	accessToken string,
	target any,
) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, flow.server+path, nil)
	if err != nil {
		return accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	response, err := flow.client.Do(request)
	if err != nil {
		return accountauth.ErrProviderUnavailable
	}
	wrapped := &httpResponse{status: response.StatusCode, body: response.Body}
	defer wrapped.close()
	return decodePayload(wrapped, target)
}

// selectOrganization 按上游给的 org_id 选组织；没给就取排序后的第一个（与官方 CLI 一致）。
func selectOrganization(orgs []consoleOrg, orgID string) *consoleOrg {
	if orgID != "" {
		for index := range orgs {
			if orgs[index].ID == orgID {
				return &orgs[index]
			}
		}
		return nil
	}
	if len(orgs) == 0 {
		return nil
	}
	sorted := make([]consoleOrg, len(orgs))
	copy(sorted, orgs)
	sort.Slice(sorted, func(left int, right int) bool {
		if sorted[left].Name != sorted[right].Name {
			return sorted[left].Name < sorted[right].Name
		}
		return sorted[left].ID < sorted[right].ID
	})
	return &sorted[0]
}

// buildArtifacts 生成 native_auth_json：形状与 Node 从宿主 opencode.db 登记的凭据一致。
func buildArtifacts(
	server string,
	payload deviceTokenPayload,
	user consoleUser,
	organization *consoleOrg,
	now time.Time,
) ([]byte, error) {
	metadata := map[string]any{
		"server":    server,
		"accountID": user.ID,
		"email":     user.Email,
	}
	if organization != nil {
		metadata["orgID"] = organization.ID
		metadata["orgName"] = organization.Name
	}
	value := map[string]any{
		"type":     "oauth",
		"methodID": "device",
		"access":   payload.AccessToken,
		"refresh":  payload.RefreshToken,
		"expires":  now.Add(time.Duration(payload.ExpiresIn) * time.Second).UnixMilli(),
		"metadata": metadata,
	}
	nativeAuth, err := json.Marshal(map[string]any{
		"auth": map[string]any{"opencode": value},
	})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	artifacts, err := json.Marshal(struct {
		NativeAuthJSON json.RawMessage `json:"native_auth_json"`
	}{NativeAuthJSON: nativeAuth})
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	return artifacts, nil
}
