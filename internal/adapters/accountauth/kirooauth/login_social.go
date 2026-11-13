package kirooauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"

	_ "modernc.org/sqlite"
)

const (
	// socialClientID 是 Kiro CLI / Desktop Social 设备流公开客户端标识（与 Node 同常量）。
	socialClientID = "820fd6d1-95c0-4ca4-bffb-3f01d32da842"
	socialAuthPath = "/oauth/device/authorization"
	socialPollPath = "/oauth/device/poll"
	desktopRefresh = "/refreshToken"
	socialUserAgent = "Kiro-CLI"

	credentialSocialTokenKey = "kirocli:social:token"
	credentialAuthMetaKey    = "aih:kiro:auth-meta"
	listProfilesTarget       = "AmazonCodeWhispererService.ListAvailableProfiles"
)

var (
	// ErrLocalSourceUnavailable 表示本机 Kiro IDE 登录态文件缺失、损坏或无 refreshToken。
	ErrLocalSourceUnavailable = errors.New("本机 Kiro IDE 登录态不可用")
)

// Compile-time port assertions for socialFlow.
var (
	_ accountauth.DeviceFlow            = (*socialFlow)(nil)
	_ accountauth.DeviceCodeProvider    = (*socialFlow)(nil)
	_ accountauth.AccountClaimsProvider = (*socialFlow)(nil)
	_ accountauth.AuthStrategyProvider  = (*socialFlow)(nil)
)

// RefreshTokenImportInput 描述 Kiro Desktop / Social refresh_token 导入命令。
type RefreshTokenImportInput struct {
	RefreshToken          string
	Region                string
	ProfileARN            string
	Provider              string
	AuthSourceFingerprint string
}

// ImportResult 返回验证并补齐 GetUsageLimits 证据后的 Kiro 原生 artifact 与公开账号资料。
type ImportResult struct {
	Artifacts   []byte
	Account     accountauth.Account
	Fingerprint string
	ProfileARN  string
	Provider    string
}

func normalizeDesktopRegion(value string) string {
	region := strings.ToLower(strings.TrimSpace(value))
	if len(region) < 7 {
		return kiro.DefaultRegion
	}
	if region == "us-east-1" || region == "us-west-2" || region == "eu-central-1" {
		return region
	}
	return kiro.DefaultRegion
}

// NormalizeSocialLoginProvider 把 Google / GitHub 入口参数归一成 Kiro Social 协议值；
// Builder ID（空串 / builder-id）返回空串，其余不可识别值返回 ok=false。
func NormalizeSocialLoginProvider(value string) (normalized string, isBuilderID bool, ok bool) {
	trimmed := strings.ToLower(strings.TrimSpace(value))
	switch trimmed {
	case "", "builder-id", "builder_id", "aws-builder-id", "aws_builder_id":
		return "", true, true
	case "google":
		return "Google", false, true
	case "github":
		return "Github", false, true
	default:
		return "", false, false
	}
}

func normalizeSocialSlotProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "google":
		return "google"
	case "github":
		return "github"
	default:
		return ""
	}
}

// KiroLocalIdentity 生成与 Node kiroLocalIdentity 同口径的稳定来源指纹。
func KiroLocalIdentity(refreshToken string) string {
	trimmed := strings.TrimSpace(refreshToken)
	if trimmed == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(trimmed))
	return "kiro-oauth-refresh:" + hex.EncodeToString(sum[:])[:32]
}

// BeginWithOptions 根据 authStrategy / loginProvider 启动 AWS Builder ID 或 Kiro Social 设备码流程。
func (provider *LoginProvider) BeginWithOptions(
	ctx context.Context,
	options accountauth.BeginOptions,
) (accountauth.OAuthFlow, error) {
	if provider == nil || provider.client == nil || provider.clock == nil {
		return nil, accountauth.ErrInvalidDependencies
	}
	strategy := strings.ToLower(strings.TrimSpace(options.AuthStrategy))
	switch strategy {
	case "", "oauth-device", "builder-id", "social", "social-oauth-device", "oauth-refresh-token":
	default:
		return nil, accountauth.ErrUnsupportedAuthStrategy
	}
	loginProvider, isBuilderID, ok := NormalizeSocialLoginProvider(options.LoginProvider)
	if !ok {
		return nil, accountauth.ErrUnsupportedLoginProvider
	}
	if strategy == "oauth-refresh-token" {
		return &refreshTokenFlow{
			provider: provider,
			social:   normalizeSocialSlotProvider(loginProvider),
		}, nil
	}
	if isBuilderID {
		if strategy == "social" || strategy == "social-oauth-device" {
			return nil, accountauth.ErrUnsupportedLoginProvider
		}
		return provider.Begin(ctx)
	}
	return provider.beginSocialDeviceFlow(ctx, loginProvider, strategy)
}

type socialFlow struct {
	client        *http.Client
	clock         Clock
	desktopBase   string
	usageBase     string
	region        string
	clientID      string
	loginProvider string
	authStrategy  string
	deviceCode    string
	userCode      string
	authorization string
	expiresAt     time.Time
	interval      time.Duration
	grant         *deviceGrant
	profileARN    string
	socialProv    string
	terminal      *PollResult
	claims        accountauth.Account
}

func (provider *LoginProvider) beginSocialDeviceFlow(
	ctx context.Context,
	loginProvider string,
	authStrategy string,
) (*socialFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	region := kiro.DefaultRegion
	desktopBase := strings.TrimSuffix(provider.desktopBase(region), "/")
	result, err := postSocialJSON(ctx, provider.client, desktopBase+socialAuthPath, map[string]string{
		"clientId":      socialClientID,
		"loginProvider": loginProvider,
	}, maxBodyBytes)
	if err != nil {
		return nil, err
	}
	if result.status != http.StatusOK {
		if result.status >= 400 && result.status < 500 {
			return nil, accountauth.ErrProviderRejected
		}
		return nil, accountauth.ErrProviderUnavailable
	}
	var payload struct {
		DeviceCode              string  `json:"deviceCode"`
		UserCode                string  `json:"userCode"`
		VerificationURI         string  `json:"verificationUri"`
		VerificationURIComplete string  `json:"verificationUriComplete"`
		ExpiresInMilliseconds   float64 `json:"expiresInMilliseconds"`
		IntervalInMilliseconds  float64 `json:"intervalInMilliseconds"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	if !validLoginSecret(payload.DeviceCode) || strings.TrimSpace(payload.UserCode) == "" {
		return nil, accountauth.ErrProviderUnavailable
	}
	verification, err := resolveVerificationURL(desktopBase, payload.VerificationURIComplete)
	if err != nil || verification == "" {
		verification, err = resolveVerificationURL(desktopBase, payload.VerificationURI)
	}
	if err != nil || verification == "" {
		return nil, accountauth.ErrProviderUnavailable
	}
	interval := defaultInterval
	if payload.IntervalInMilliseconds > 0 {
		interval = normalizeInterval(int64((payload.IntervalInMilliseconds + 500) / 1000.0))
	}
	expiresIn := 5 * time.Minute
	if payload.ExpiresInMilliseconds > 0 {
		expiresIn = time.Duration(payload.ExpiresInMilliseconds) * time.Millisecond
	}
	resolvedStrategy := strings.TrimSpace(authStrategy)
	if resolvedStrategy == "" {
		resolvedStrategy = "social-oauth-device"
	}
	return &socialFlow{
		client:        provider.client,
		clock:         provider.clock,
		desktopBase:   desktopBase,
		usageBase:     provider.usageBase(region),
		region:        region,
		clientID:      socialClientID,
		loginProvider: loginProvider,
		authStrategy:  resolvedStrategy,
		deviceCode:    strings.TrimSpace(payload.DeviceCode),
		userCode:      strings.TrimSpace(payload.UserCode),
		authorization: verification,
		expiresAt:     provider.clock().UTC().Add(expiresIn),
		interval:      interval,
	}, nil
}

func (flow *socialFlow) AuthorizationURL() string {
	if flow == nil {
		return ""
	}
	return flow.authorization
}

func (flow *socialFlow) UserCode() string {
	if flow == nil {
		return ""
	}
	return flow.userCode
}

func (flow *socialFlow) PollInterval() time.Duration {
	if flow == nil || flow.interval <= 0 {
		return defaultInterval
	}
	return flow.interval
}

func (flow *socialFlow) AccountClaims() accountauth.Account {
	if flow == nil {
		return accountauth.Account{}
	}
	return flow.claims
}

func (flow *socialFlow) AuthStrategy() string {
	if flow == nil {
		return ""
	}
	return flow.authStrategy
}

func (flow *socialFlow) Exchange(ctx context.Context, _ string) ([]byte, error) {
	polled, err := flow.Poll(ctx)
	if err != nil {
		return nil, err
	}
	if polled.Status != accountauth.DeviceReady {
		return nil, accountauth.ErrProviderRejected
	}
	return polled.Artifacts, nil
}

func (flow *socialFlow) Poll(ctx context.Context) (PollResult, error) {
	if flow == nil {
		return PollResult{}, accountauth.ErrInvalidDependencies
	}
	if flow.terminal != nil {
		return *flow.terminal, nil
	}
	if flow.grant != nil {
		return flow.materialize(ctx, *flow.grant, flow.profileARN, flow.socialProv)
	}
	if flow.deviceCode == "" {
		return flow.finish(PollResult{Status: accountauth.DeviceFailed}), nil
	}
	if !flow.expiresAt.IsZero() && !flow.clock().UTC().Before(flow.expiresAt) {
		return flow.finish(PollResult{Status: accountauth.DeviceExpired}), nil
	}
	result, err := postSocialJSON(ctx, flow.client, flow.desktopBase+socialPollPath, map[string]string{
		"clientId":   flow.clientID,
		"deviceCode": flow.deviceCode,
	}, maxBodyBytes)
	if err != nil {
		return PollResult{}, err
	}
	if result.status != http.StatusOK {
		if result.status >= 400 && result.status < 500 {
			return flow.finish(PollResult{Status: accountauth.DeviceFailed}), nil
		}
		return PollResult{}, accountauth.ErrProviderUnavailable
	}
	var payload struct {
		Status           string `json:"status"`
		AccessToken      string `json:"accessToken"`
		RefreshToken     string `json:"refreshToken"`
		ProfileARN       string `json:"profileArn"`
		IdentityProvider string `json:"identityProvider"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return PollResult{}, accountauth.ErrProviderUnavailable
	}
	switch strings.TrimSpace(payload.Status) {
	case "authorization_pending":
		return PollResult{Status: accountauth.DevicePending, Interval: flow.interval}, nil
	case "invalid_token":
		return flow.finish(PollResult{Status: accountauth.DeviceExpired}), nil
	}
	if !validLoginSecret(payload.AccessToken) || !validLoginSecret(payload.RefreshToken) {
		return flow.finish(PollResult{Status: accountauth.DeviceFailed}), nil
	}
	grant := deviceGrant{
		accessToken:  strings.TrimSpace(payload.AccessToken),
		refreshToken: strings.TrimSpace(payload.RefreshToken),
		expiresAt:    flow.clock().UTC().Add(defaultTokenTTL),
		region:       flow.region,
	}
	profileARN := strings.TrimSpace(payload.ProfileARN)
	socialProvider := strings.TrimSpace(payload.IdentityProvider)
	if socialProvider == "" {
		socialProvider = flow.loginProvider
	}
	flow.grant = &grant
	flow.profileARN = profileARN
	flow.socialProv = socialProvider
	flow.deviceCode = ""
	return flow.materialize(ctx, grant, profileARN, socialProvider)
}

func (flow *socialFlow) finish(result PollResult) PollResult {
	flow.terminal = &result
	flow.deviceCode = ""
	return result
}

func (flow *socialFlow) materialize(
	ctx context.Context,
	grant deviceGrant,
	profileARN string,
	socialProvider string,
) (PollResult, error) {
	if profileARN == "" {
		if resolved, err := resolveSingleProfileARN(ctx, flow.client, flow.usageBase, grant.accessToken); err == nil && resolved != "" {
			profileARN = resolved
			flow.profileARN = resolved
		}
	}
	usage, err := fetchUsageLimits(ctx, flow.client, flow.usageBase, grant.accessToken, profileARN)
	if err != nil {
		if errors.Is(err, accountauth.ErrProviderRejected) {
			return flow.finish(PollResult{Status: accountauth.DeviceFailed}), nil
		}
		return PollResult{}, err
	}
	now := flow.clock().UTC()
	artifacts, err := buildSocialArtifacts(grant, profileARN, socialProvider, "", usage, now)
	if err != nil {
		return PollResult{}, err
	}
	flow.claims = accountauth.Account{
		Email:       usage.email,
		DisplayName: usage.email,
	}
	return flow.finish(PollResult{
		Status:    accountauth.DeviceReady,
		Artifacts: artifacts,
		Account:   flow.claims,
	}), nil
}

// ImportRefreshToken 通过 Kiro Desktop /refreshToken 兑换可用 access_token 并验证身份后构建原生 artifact。
func (provider *LoginProvider) ImportRefreshToken(
	ctx context.Context,
	input RefreshTokenImportInput,
) (ImportResult, error) {
	if provider == nil || provider.client == nil || provider.clock == nil {
		return ImportResult{}, accountauth.ErrInvalidDependencies
	}
	refreshToken := strings.TrimSpace(input.RefreshToken)
	if !validLoginSecret(refreshToken) {
		return ImportResult{}, accountauth.ErrInvalidArtifacts
	}
	region := normalizeDesktopRegion(input.Region)
	desktopBase := strings.TrimSuffix(provider.desktopBase(region), "/")
	result, err := postJSON(ctx, provider.client, desktopBase+desktopRefresh, map[string]string{
		"refreshToken": refreshToken,
	}, maxBodyBytes)
	if err != nil {
		return ImportResult{}, err
	}
	if result.status == http.StatusUnauthorized || result.status == http.StatusForbidden {
		return ImportResult{}, accountauth.ErrProviderRejected
	}
	if result.status != http.StatusOK {
		return ImportResult{}, accountauth.ErrProviderUnavailable
	}
	var payload struct {
		AccessToken  string  `json:"accessToken"`
		RefreshToken string  `json:"refreshToken"`
		ExpiresIn    float64 `json:"expiresIn"`
		ProfileARN   string  `json:"profileArn"`
	}
	if err := oauthutil.DecodeJSONResponse(bytes.NewReader(result.body), maxBodyBytes, &payload); err != nil {
		return ImportResult{}, accountauth.ErrProviderUnavailable
	}
	accessToken := strings.TrimSpace(payload.AccessToken)
	if !validLoginSecret(accessToken) {
		return ImportResult{}, accountauth.ErrProviderRejected
	}
	nextRefresh := strings.TrimSpace(payload.RefreshToken)
	if !validLoginSecret(nextRefresh) {
		nextRefresh = refreshToken
	}
	ttl := defaultTokenTTL
	if payload.ExpiresIn > 0 {
		ttl = time.Duration(payload.ExpiresIn * float64(time.Second))
	}
	now := provider.clock().UTC()
	grant := deviceGrant{
		accessToken:  accessToken,
		refreshToken: nextRefresh,
		expiresAt:    now.Add(ttl),
		region:       region,
	}
	profileARN := strings.TrimSpace(payload.ProfileARN)
	if profileARN == "" {
		profileARN = strings.TrimSpace(input.ProfileARN)
	}
	usageBase := provider.usageBase(region)
	if profileARN == "" {
		if resolved, err := resolveSingleProfileARN(ctx, provider.client, usageBase, accessToken); err == nil && resolved != "" {
			profileARN = resolved
		}
	}
	usage, err := fetchUsageLimits(ctx, provider.client, usageBase, accessToken, profileARN)
	if err != nil {
		return ImportResult{}, err
	}
	fingerprint := strings.TrimSpace(input.AuthSourceFingerprint)
	socialProvider := strings.TrimSpace(input.Provider)
	artifacts, err := buildSocialArtifacts(grant, profileARN, socialProvider, fingerprint, usage, now)
	if err != nil {
		return ImportResult{}, err
	}
	return ImportResult{
		Artifacts: artifacts,
		Account: accountauth.Account{
			Email:       usage.email,
			DisplayName: usage.email,
		},
		Fingerprint: fingerprint,
		ProfileARN:  profileARN,
		Provider:    socialProvider,
	}, nil
}

// ImportIDELocal 从宿主家目录 ~/.aws/sso/cache/kiro-auth-token.json 导入本机 Kiro IDE 登录态。
func (provider *LoginProvider) ImportIDELocal(
	ctx context.Context,
	hostHomeDir string,
) (ImportResult, error) {
	trimmedHome := strings.TrimSpace(hostHomeDir)
	if trimmedHome == "" {
		return ImportResult{}, ErrLocalSourceUnavailable
	}
	tokenPath := filepath.Join(trimmedHome, ".aws", "sso", "cache", "kiro-auth-token.json")
	raw, err := os.ReadFile(tokenPath)
	if err != nil {
		return ImportResult{}, ErrLocalSourceUnavailable
	}
	var doc struct {
		RefreshToken string `json:"refreshToken"`
		ProfileARN   string `json:"profileArn"`
		Provider     string `json:"provider"`
		AuthMethod   string `json:"authMethod"`
	}
	if json.Unmarshal(raw, &doc) != nil || !validLoginSecret(doc.RefreshToken) {
		return ImportResult{}, ErrLocalSourceUnavailable
	}
	fingerprint := KiroLocalIdentity(doc.RefreshToken)
	return provider.ImportRefreshToken(ctx, RefreshTokenImportInput{
		RefreshToken:          strings.TrimSpace(doc.RefreshToken),
		ProfileARN:            strings.TrimSpace(doc.ProfileARN),
		Provider:              strings.TrimSpace(doc.Provider),
		AuthSourceFingerprint: fingerprint,
	})
}

func resolveSingleProfileARN(
	ctx context.Context,
	client *http.Client,
	usageBase string,
	accessToken string,
) (string, error) {
	endpoint := strings.TrimSuffix(usageBase, "/") + "/"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader([]byte(`{"origin":"CLI"}`)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Content-Type", "application/x-amz-json-1.0")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-amz-target", listProfilesTarget)
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", accountauth.ErrProviderUnavailable
	}
	var doc struct {
		Profiles []struct {
			ARN        string `json:"arn"`
			ProfileARN string `json:"profileArn"`
		} `json:"profiles"`
		ProfileList []struct {
			ARN        string `json:"arn"`
			ProfileARN string `json:"profileArn"`
		} `json:"profileList"`
	}
	if err := oauthutil.DecodeJSONResponse(response.Body, maxUsageBodyBytes, &doc); err != nil {
		return "", err
	}
	seen := map[string]struct{}{}
	var arns []string
	appendARN := func(raw string) {
		v := strings.TrimSpace(raw)
		if v == "" {
			return
		}
		if _, exists := seen[v]; exists {
			return
		}
		seen[v] = struct{}{}
		arns = append(arns, v)
	}
	for _, item := range doc.Profiles {
		appendARN(item.ARN)
		appendARN(item.ProfileARN)
	}
	for _, item := range doc.ProfileList {
		appendARN(item.ARN)
		appendARN(item.ProfileARN)
	}
	if len(arns) == 1 {
		return arns[0], nil
	}
	return "", nil
}

func buildSocialArtifacts(
	grant deviceGrant,
	profileARN string,
	socialProvider string,
	fingerprint string,
	usage usageLimits,
	now time.Time,
) ([]byte, error) {
	endpoint := "https://codewhisperer." + grant.region + ".amazonaws.com"
	binding := tokenBinding(endpoint, grant.accessToken, grant.refreshToken)
	if binding == "" {
		return nil, accountauth.ErrInvalidArtifacts
	}
	authRow := map[string]any{
		"access_token":  grant.accessToken,
		"refresh_token": grant.refreshToken,
		"expires_at":    grant.expiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		"region":        grant.region,
		"authMethod":    "social",
	}
	if trimmedProv := strings.TrimSpace(socialProvider); trimmedProv != "" {
		authRow["provider"] = trimmedProv
	}
	if trimmedARN := strings.TrimSpace(profileARN); trimmedARN != "" {
		authRow["profileArn"] = trimmedARN
	}
	if trimmedFP := strings.TrimSpace(fingerprint); trimmedFP != "" {
		authRow["authSourceFingerprint"] = trimmedFP
	}
	database, err := buildSocialCredentialDatabase(authRow, socialProvider, profileARN, fingerprint)
	if err != nil {
		return nil, accountauth.ErrInvalidArtifacts
	}
	nativeMap := map[string]any{
		"auth":     authRow,
		"flavor":   string(kiro.FlavorDesktop),
		"database": database,
		"identityEvidence": map[string]any{
			"version":      evidenceVersion,
			"source":       evidenceSource,
			"endpoint":     endpoint,
			"subject":      usage.userID,
			"tokenBinding": binding,
			"observedAtMs": now.UnixMilli(),
		},
	}
	if trimmedARN := strings.TrimSpace(profileARN); trimmedARN != "" {
		nativeMap["profileArn"] = trimmedARN
	}
	nativeAuth, err := json.Marshal(nativeMap)
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

func buildSocialCredentialDatabase(
	authRow map[string]any,
	socialProvider string,
	profileARN string,
	fingerprint string,
) (string, error) {
	directory, err := os.MkdirTemp("", "aih-kiro-social-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(directory) }()
	databasePath := filepath.Join(directory, "data.sqlite3")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return "", err
	}
	closed := false
	defer func() {
		if !closed {
			_ = database.Close()
		}
	}()
	if _, err := database.Exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		return "", err
	}
	insert, err := database.Prepare(`INSERT INTO auth_kv (key, value) VALUES (?, ?)`)
	if err != nil {
		return "", err
	}
	defer func() { _ = insert.Close() }()

	slotProvider := normalizeSocialSlotProvider(socialProvider)
	if slotProvider != "" {
		slotJSON, err := json.Marshal(map[string]any{
			"access_token":  authRow["access_token"],
			"expires_at":    authRow["expires_at"],
			"refresh_token": authRow["refresh_token"],
			"provider":      slotProvider,
			"profile_arn":   strings.TrimSpace(profileARN),
		})
		if err != nil {
			return "", err
		}
		if _, err := insert.Exec(credentialSocialTokenKey, string(slotJSON)); err != nil {
			return "", err
		}
		meta := map[string]any{"authMethod": "social"}
		if trimmedFP := strings.TrimSpace(fingerprint); trimmedFP != "" {
			meta["authSourceFingerprint"] = trimmedFP
		}
		metaJSON, err := json.Marshal(meta)
		if err != nil {
			return "", err
		}
		if _, err := insert.Exec(credentialAuthMetaKey, string(metaJSON)); err != nil {
			return "", err
		}
	} else {
		authJSON, err := json.Marshal(authRow)
		if err != nil {
			return "", err
		}
		if _, err := insert.Exec(credentialTokenKey, string(authJSON)); err != nil {
			return "", err
		}
	}
	if err := database.Close(); err != nil {
		return "", err
	}
	closed = true
	rawBytes, err := os.ReadFile(databasePath)
	if err != nil || len(rawBytes) == 0 {
		return "", accountauth.ErrInvalidArtifacts
	}
	return base64.StdEncoding.EncodeToString(rawBytes), nil
}

func postSocialJSON(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	payload any,
	limit int64,
) (*httpResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", socialUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, accountauth.ErrProviderUnavailable
	}
	return &httpResult{status: response.StatusCode, body: raw}, nil
}


var (
	_ accountauth.OAuthFlow             = (*refreshTokenFlow)(nil)
	_ accountauth.AuthModeProvider      = (*refreshTokenFlow)(nil)
	_ accountauth.AuthStrategyProvider  = (*refreshTokenFlow)(nil)
	_ accountauth.AccountClaimsProvider = (*refreshTokenFlow)(nil)
)

type refreshTokenFlow struct {
	provider *LoginProvider
	social   string
	claims   accountauth.Account
}

func (*refreshTokenFlow) AuthorizationURL() string {
	return ""
}

func (*refreshTokenFlow) AuthMode() string {
	return "oauth-refresh-token"
}

func (*refreshTokenFlow) AuthStrategy() string {
	return "oauth-refresh-token"
}

func (flow *refreshTokenFlow) AccountClaims() accountauth.Account {
	return flow.claims
}

func (flow *refreshTokenFlow) Exchange(ctx context.Context, callback string) ([]byte, error) {
	token := strings.TrimSpace(callback)
	if !validLoginSecret(token) {
		return nil, accountauth.ErrProviderRejected
	}
	imp, err := flow.provider.ImportRefreshToken(ctx, RefreshTokenImportInput{
		RefreshToken:          token,
		Provider:              flow.social,
		AuthSourceFingerprint: KiroLocalIdentity(token),
	})
	if err != nil {
		return nil, err
	}
	flow.claims = imp.Account
	return imp.Artifacts, nil
}
