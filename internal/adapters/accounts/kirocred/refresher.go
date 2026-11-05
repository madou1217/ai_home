// Package kirocred 负责 kiro 的纯 HTTP 令牌刷新与 CAS 落库。
//
// 两种口径（见 core/accounts/kiro 的 Flavor）：
//   - oidc：POST https://oidc.<region>.amazonaws.com/token
//     {clientId, clientSecret, grantType:"refresh_token", refreshToken}
//   - desktop：POST https://prod.<region>.auth.desktop.kiro.dev/refreshToken
//     {refreshToken}
//
// 刷新成功后重算 identityEvidence.tokenBinding 并解码成新的原生凭据，
// 再走凭据版本 CAS 写回；身份种子（endpoint + subject）不变。
package kirocred

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	maxResponseBytes = 64 * 1024
	requestTimeout   = 10 * time.Second
)

var (
	ErrInvalidDependencies = errors.New("kiro 凭据刷新依赖无效")
	ErrCannotRefresh       = errors.New("kiro 凭据缺少刷新所需字段")
)

// HTTPClient 是最小传输端口。
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

// Refresher 在模型发现前刷新过期凭据。
type Refresher struct {
	credentials accountapp.CredentialVersionStore
	client      HTTPClient
	clock       func() time.Time
	oidcURL     func(region string) string
	desktopURL  func(region string) string
}

// New 创建生产端点上的刷新器。
func New(
	credentials accountapp.CredentialVersionStore,
	client HTTPClient,
	clock func() time.Time,
) (*Refresher, error) {
	if credentials == nil || client == nil || clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Refresher{
		credentials: credentials,
		client:      client,
		clock:       clock,
		oidcURL: func(region string) string {
			return fmt.Sprintf("https://oidc.%s.amazonaws.com/token", region)
		},
		desktopURL: func(region string) string {
			return fmt.Sprintf("https://prod.%s.auth.desktop.kiro.dev/refreshToken", region)
		},
	}, nil
}

// RefreshCredential 在 token 不新鲜时刷新并落库；否则原样返回快照。
func (refresher *Refresher) RefreshCredential(
	ctx context.Context,
	snapshot accountapp.CredentialSnapshot,
) (accountapp.CredentialSnapshot, error) {
	if refresher == nil || ctx == nil || !snapshot.IsValid() {
		return accountapp.CredentialSnapshot{}, ErrInvalidDependencies
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != kiro.ProviderID {
		return snapshot, nil
	}
	credential, err := kiro.ParseCredential(native.Payload())
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	now := refresher.clock().UTC()
	if credential.IsAccessTokenFresh(now) {
		return snapshot, nil
	}
	if !credential.CanRefresh() {
		return accountapp.CredentialSnapshot{}, ErrCannotRefresh
	}
	grant, err := refresher.refresh(ctx, credential)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	payload, err := credential.WithGrant(grant)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	refreshed, err := nativeaccount.NewDecoder().DecodeNativeAuth(kiro.ProviderID, payload)
	if err != nil || refreshed == nil {
		return accountapp.CredentialSnapshot{}, accountapp.ErrInvalidCredentialReplacement
	}
	updatedAt := now
	// CAS 版本必须严格递增；同一毫秒内刷新时顺延 1ms。
	if !updatedAt.After(snapshot.UpdatedAt()) {
		updatedAt = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, refreshed, updatedAt)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	if err := refresher.credentials.ReplaceCredential(ctx, replacement); err != nil {
		// 竞争失败：别的进程先刷新了，重新读一次快照（通常已经新鲜）。
		if errors.Is(err, accountapp.ErrCredentialConflict) {
			current, readErr := refresher.credentials.GetCredentialSnapshot(ctx, snapshot.AccountRef())
			if readErr == nil && current.IsValid() {
				return current, nil
			}
		}
		return accountapp.CredentialSnapshot{}, err
	}
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		kiro.ProviderID,
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	return next, nil
}

func (refresher *Refresher) refresh(
	ctx context.Context,
	credential kiro.Credential,
) (kiro.Grant, error) {
	region := credential.Region()
	if credential.Flavor() == kiro.FlavorOIDC {
		return refresher.requestGrant(ctx, refresher.oidcURL(region), map[string]string{
			"clientId":     credential.ClientID(),
			"clientSecret": credential.ClientSecret(),
			"grantType":    "refresh_token",
			"refreshToken": credential.RefreshToken(),
		}, region, false)
	}
	return refresher.requestGrant(ctx, refresher.desktopURL(region), map[string]string{
		"refreshToken": credential.RefreshToken(),
	}, region, true)
}

type grantResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int64  `json:"expiresIn"`
	ProfileARN   string `json:"profileArn"`
}

func (refresher *Refresher) requestGrant(
	ctx context.Context,
	endpoint string,
	body map[string]string,
	region string,
	acceptProfileARN bool,
) (kiro.Grant, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return kiro.Grant{}, ErrInvalidDependencies
	}
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return kiro.Grant{}, ErrInvalidDependencies
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := refresher.client.Do(request)
	if err != nil {
		return kiro.Grant{}, fmt.Errorf("kiro 令牌刷新失败: %w", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return kiro.Grant{}, fmt.Errorf("kiro 令牌刷新失败: HTTP %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return kiro.Grant{}, err
	}
	if len(raw) > maxResponseBytes {
		return kiro.Grant{}, fmt.Errorf("kiro 令牌刷新响应过大")
	}
	var document grantResponse
	if json.Unmarshal(raw, &document) != nil || strings.TrimSpace(document.AccessToken) == "" {
		return kiro.Grant{}, fmt.Errorf("kiro 令牌刷新响应缺少 accessToken")
	}
	expiresIn := document.ExpiresIn
	if expiresIn <= 0 {
		expiresIn = 3600
	}
	grant := kiro.Grant{
		AccessToken:  strings.TrimSpace(document.AccessToken),
		RefreshToken: strings.TrimSpace(document.RefreshToken),
		ExpiresAt:    refresher.clock().UTC().Add(time.Duration(expiresIn) * time.Second),
		Region:       region,
	}
	if acceptProfileARN {
		grant.ProfileARN = strings.TrimSpace(document.ProfileARN)
	}
	return grant, nil
}

// Refresh 只做协议刷新，不写库：返回身份不变的新领域凭据。
//
// 供 credential resolver 的 RefreshStrategy 使用（写回与 CAS 由 resolver 负责）。
// 与 RefreshCredential 的差别只有「不碰存储」。
func (refresher *Refresher) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
) (accountapp.Credential, error) {
	if refresher == nil || ctx == nil {
		return nil, ErrInvalidDependencies
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != kiro.ProviderID {
		return credential, nil
	}
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil {
		return nil, err
	}
	if parsed.IsAccessTokenFresh(refresher.clock().UTC()) {
		return native, nil
	}
	if !parsed.CanRefresh() {
		return nil, ErrCannotRefresh
	}
	grant, err := refresher.refresh(ctx, parsed)
	if err != nil {
		return nil, err
	}
	payload, err := parsed.WithGrant(grant)
	if err != nil {
		return nil, err
	}
	refreshed, err := nativeaccount.NewDecoder().DecodeNativeAuth(kiro.ProviderID, payload)
	if err != nil || refreshed == nil {
		return nil, accountapp.ErrInvalidCredentialReplacement
	}
	return refreshed, nil
}
