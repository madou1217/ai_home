// Package tokenrefresh 用官方 CLI 的 /v2/plugin/auth/token/refresh 续期
// CodeBuddy 家族的原生凭据。
//
// 官方 CLI 并不是只在 exp 到期时才刷新：网关返回 401/403 后也会刷新并
// 轮换 refresh_token。aih 之前只按 exp 判断，导致上游吊销旧 session 后
// 账号被永久标记为需要重新登录。这里提供同账号的官方刷新，刷新成功即
// CAS 回写账号库；只有 refresh_token 明确被吊销时才让上层要求重新登录。
package tokenrefresh

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/cliversion"
)

const (
	refreshPath      = "/v2/plugin/auth/token/refresh"
	maxResponseBytes = 1 << 20
	requestTimeout   = 15 * time.Second
	freshTokenSkew   = 5 * time.Minute
)

// ErrCannotRefresh 表示账号没有可用的 refresh token。
var ErrCannotRefresh = errors.New("CodeBuddy 凭据没有 refresh token")

// ErrRefreshFailed 表示刷新请求失败但可重试（网络/5xx/响应格式）。
var ErrRefreshFailed = errors.New("CodeBuddy 凭据刷新失败")

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// CredentialStore 是 CAS 回写凭据所需的最小端口。
type CredentialStore interface {
	GetCredentialSnapshot(ctx context.Context, accountRef accountcore.AccountRef) (accountapp.CredentialSnapshot, error)
	ReplaceCredential(ctx context.Context, replacement accountapp.CredentialReplacement) error
}

// Refresher 为一个 CodeBuddy 家族账号刷新原生凭据。
type Refresher struct {
	client      HTTPClient
	credentials CredentialStore
	now         func() time.Time
	endpoint    func(providerID string) string
}

// Options 是 Refresher 的依赖；Endpoint 为空时使用 Provider 合同的默认域名。
type Options struct {
	Client      HTTPClient
	Credentials CredentialStore
	Clock       func() time.Time
	Endpoint    func(providerID string) string
}

// New 创建刷新器。
func New(options Options) (*Refresher, error) {
	if options.Client == nil || options.Credentials == nil {
		return nil, ErrRefreshFailed
	}
	now := options.Clock
	if now == nil {
		now = time.Now
	}
	endpoint := options.Endpoint
	if endpoint == nil {
		endpoint = defaultEndpoint
	}
	return &Refresher{
		client:      options.Client,
		credentials: options.Credentials,
		now:         now,
		endpoint:    endpoint,
	}, nil
}

func defaultEndpoint(providerID string) string {
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "codebuddy":
		return providers.CodeBuddyBaseURL
	case "codebuddycn", "workbuddycn":
		return providers.TencentCopilotBaseURL
	case "workbuddy":
		return providers.WorkBuddyBaseURL
	default:
		return ""
	}
}

// RefreshCredential 在 access token 即将过期时刷新；force=false 时保持
// 原有 usage 预刷新语义。
func (refresher *Refresher) RefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	return refresher.refresh(ctx, snapshot, false)
}

// ForceRefreshCredential 在被网关 401/403 后强制刷新，即便 exp 还没到。
func (refresher *Refresher) ForceRefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	return refresher.refresh(ctx, snapshot, true)
}

func (refresher *Refresher) refresh(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
	force bool,
) (accountapp.CredentialSnapshot, error) {
	if refresher == nil || ctx == nil || !snapshot.IsValid() {
		return accountapp.CredentialSnapshot{}, ErrRefreshFailed
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil {
		return snapshot, nil
	}
	providerID := native.ProviderID()
	if !providers.IsCodeBuddyFamilyProvider(providerID) {
		return snapshot, nil
	}
	document, credentials, auth, err := parsePayload(native.Payload())
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	accessToken := text(auth["accessToken"])
	refreshToken := text(auth["refreshToken"])
	if refreshToken == "" {
		return accountapp.CredentialSnapshot{}, ErrCannotRefresh
	}
	if !force {
		if tokenFresh(accessToken, refresher.now()) || refreshedRecently(auth, refresher.now()) {
			return snapshot, nil
		}
	} else {
		// 预刷新可能刚刚轮换过：直接复用严格更新的当前代次，避免连续
		// 两次刷新把刚拿到的 refresh_token 又轮换掉。
		if current, readErr := refresher.credentials.GetCredentialSnapshot(ctx, snapshot.AccountRef()); readErr == nil &&
			current.IsValid() && current.UpdatedAt().After(snapshot.UpdatedAt()) {
			return current, nil
		}
	}
	endpoint := strings.TrimSpace(refresher.endpoint(providerID))
	if endpoint == "" {
		return accountapp.CredentialSnapshot{}, ErrRefreshFailed
	}
	payload, credentialRejected, err := refresher.call(ctx, endpoint, auth, credentialUID(credentials))
	if err != nil {
		if credentialRejected {
			return accountapp.CredentialSnapshot{}, fmt.Errorf("%w: %v", usageapp.ErrCredentialRejected, err)
		}
		return accountapp.CredentialSnapshot{}, errors.Join(ErrRefreshFailed, err)
	}
	now := refresher.now().UTC()
	refreshed, err := applyRefreshPayload(providerID, native, document, credentials, auth, payload, now)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	updatedAt := now
	if !updatedAt.After(snapshot.UpdatedAt()) {
		updatedAt = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, refreshed, updatedAt)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if err := refresher.credentials.ReplaceCredential(ctx, replacement); err != nil {
		if errors.Is(err, accountapp.ErrCredentialConflict) {
			current, readErr := refresher.credentials.GetCredentialSnapshot(ctx, snapshot.AccountRef())
			if readErr == nil && current.IsValid() {
				return current, nil
			}
		}
		return accountapp.CredentialSnapshot{}, err
	}
	return accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		providerID,
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
}

func (refresher *Refresher) call(
	ctx context.Context,
	endpoint string,
	auth map[string]any,
	uid string,
) (map[string]any, bool, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		strings.TrimRight(endpoint, "/")+refreshPath,
		bytes.NewReader([]byte("{}")),
	)
	if err != nil {
		return nil, false, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Refresh-Token", text(auth["refreshToken"]))
	request.Header.Set("X-Auth-Refresh-Source", "plugin")
	// 官方 CLI 的认证拦截器会给刷新请求补上当前 access token 和 uid；
	// 刷新端点用它们识别会话，只有 X-Refresh-Token 会被网关直接 401。
	if accessToken := text(auth["accessToken"]); accessToken != "" {
		request.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if uid != "" {
		request.Header.Set("X-User-Id", uid)
	}
	if domain := text(auth["domain"]); domain != "" {
		request.Header.Set("X-Domain", domain)
	}
	if version := cliversion.Current(); version != "" {
		if userAgent := cliversion.UserAgent(version); userAgent != "" {
			request.Header.Set("User-Agent", userAgent)
		}
	}
	response, err := refresher.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, err
	}
	if response == nil || response.Body == nil {
		return nil, false, ErrRefreshFailed
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) == 0 || len(body) > maxResponseBytes {
		return nil, false, ErrRefreshFailed
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		detail := strings.TrimSpace(string(body))
		if len(detail) > 300 {
			detail = detail[:300]
		}
		if detail != "" {
			return nil, true, fmt.Errorf("HTTP %d: %s", response.StatusCode, detail)
		}
		return nil, true, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, false, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	var document struct {
		Code json.RawMessage "json:\"code\""
		Msg  string          "json:\"msg\""
		Data map[string]any  "json:\"data\""
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, false, ErrRefreshFailed
	}
	code := strings.Trim(strings.TrimSpace(string(document.Code)), "\"")
	if code != "" && code != "0" && code != "200" {
		if isRevokedMessage(document.Msg) {
			return nil, true, errors.New(document.Msg)
		}
		return nil, false, fmt.Errorf("code=%s msg=%s", code, document.Msg)
	}
	if len(document.Data) == 0 || text(document.Data["accessToken"]) == "" || text(document.Data["refreshToken"]) == "" {
		return nil, false, ErrRefreshFailed
	}
	return document.Data, false, nil
}

func isRevokedMessage(message string) bool {
	value := strings.ToLower(message)
	return strings.Contains(value, "revoked") ||
		strings.Contains(value, "invalid_grant") ||
		strings.Contains(value, "refresh token failed")
}

// credentialUID 读取凭据文档里的账号 uid，用于补齐官方刷新请求头。
func credentialUID(credentials map[string]any) string {
	account, _ := credentials["account"].(map[string]any)
	if account == nil {
		return ""
	}
	return text(account["uid"])
}

func parsePayload(payload []byte) (map[string]json.RawMessage, map[string]any, map[string]any, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, nil, nil, ErrRefreshFailed
	}
	var credentials map[string]any
	if err := json.Unmarshal(document["credentials"], &credentials); err != nil || credentials == nil {
		return nil, nil, nil, ErrRefreshFailed
	}
	auth, _ := credentials["auth"].(map[string]any)
	if auth == nil {
		return nil, nil, nil, ErrRefreshFailed
	}
	return document, credentials, auth, nil
}

func normalizeAuthTimes(auth map[string]any, now time.Time) {
	expiresIn := number(auth["expiresIn"])
	if _, found := auth["expiresAt"]; !found && expiresIn > 0 {
		auth["expiresAt"] = now.UnixMilli() + int64(expiresIn)*1000
	}
	refreshExpiresIn := number(auth["refreshExpiresIn"])
	if _, found := auth["refreshExpiresAt"]; !found && refreshExpiresIn > 0 {
		auth["refreshExpiresAt"] = now.UnixMilli() + int64(refreshExpiresIn)*1000
	}
	auth["lastRefreshTime"] = now.UnixMilli()
}

func refreshedRecently(auth map[string]any, now time.Time) bool {
	last := number(auth["lastRefreshTime"])
	if last <= 0 {
		return false
	}
	lastTime := time.UnixMilli(int64(last))
	return now.Sub(lastTime) < time.Minute
}

func tokenFresh(token string, now time.Time) bool {
	claims, err := parseJWTClaims(token)
	if err != nil {
		return false
	}
	expiresAt := number(claims["exp"])
	if expiresAt <= 0 {
		return false
	}
	return time.Unix(int64(expiresAt), 0).After(now.Add(freshTokenSkew))
}

func parseJWTClaims(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil, errors.New("invalid jwt")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil || claims == nil {
		return nil, errors.New("invalid claims")
	}
	return claims, nil
}

func text(value any) string {
	textValue, _ := value.(string)
	return strings.TrimSpace(textValue)
}

func number(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int64:
		return float64(typed)
	case int:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	default:
		return 0
	}
}
