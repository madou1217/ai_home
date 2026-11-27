package tokenrefresh

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// Provider 是 accountcredentials.RefreshStrategy 的协议实现：
// 只做刷新交换，不读写存储；到期判断、并发合并和 CAS 由 Resolver 统一负责。
type Provider struct {
	providerID string
	caller     *Refresher
}

// NewProvider 创建一个 Provider 级刷新实现。
//
// endpoint 为空时使用 Provider 合同的默认域名；测试可注入 httptest URL。
func NewProvider(
	providerID string,
	client HTTPClient,
	endpoint string,
	clock func() time.Time,
) (*Provider, error) {
	providerID = normalizeProvider(providerID)
	if client == nil || !providers.IsCodeBuddyFamilyProvider(providerID) {
		return nil, ErrRefreshFailed
	}
	if endpoint == "" {
		endpoint = defaultEndpoint(providerID)
	}
	if endpoint == "" {
		return nil, ErrRefreshFailed
	}
	return &Provider{
		providerID: providerID,
		caller: &Refresher{
			client:   client,
			now:      clock,
			endpoint: func(string) string { return endpoint },
		},
	}, nil
}

func (provider *Provider) ProviderID() string {
	if provider == nil {
		return ""
	}
	return provider.providerID
}

// ExpiresAt 返回 access token 的 exp；无法解析时返回 false。
func (provider *Provider) ExpiresAt(credential accountapp.Credential) (time.Time, bool) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != provider.ProviderID() {
		return time.Time{}, false
	}
	_, _, auth, err := parsePayload(native.Payload())
	if err != nil {
		return time.Time{}, false
	}
	claims, err := parseJWTClaims(text(auth["accessToken"]))
	if err != nil {
		return time.Time{}, false
	}
	expiresAt := number(claims["exp"])
	if expiresAt <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(expiresAt), 0), true
}

// Refresh 调用官方刷新端点并返回身份不变的新原生凭据。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
) (accountapp.Credential, error) {
	if provider == nil || provider.caller == nil || ctx == nil {
		return nil, ErrRefreshFailed
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != provider.providerID {
		return nil, ErrRefreshFailed
	}
	document, credentials, auth, err := parsePayload(native.Payload())
	if err != nil {
		return nil, err
	}
	if text(auth["refreshToken"]) == "" {
		return nil, ErrCannotRefresh
	}
	payload, credentialRejected, err := provider.caller.call(ctx, provider.caller.endpoint(provider.providerID), auth)
	if err != nil {
		if credentialRejected {
			return nil, usageapp.ErrCredentialRejected
		}
		return nil, errors.Join(ErrRefreshFailed, err)
	}
	return applyRefreshPayload(
		provider.providerID,
		native,
		document,
		credentials,
		auth,
		payload,
		provider.caller.now().UTC(),
	)
}

// applyRefreshPayload 把刷新响应合并回原生凭据文档并重新解码。
func applyRefreshPayload(
	providerID string,
	native *accountcore.NativeCredential,
	document map[string]json.RawMessage,
	credentials map[string]any,
	auth map[string]any,
	payload map[string]any,
	now time.Time,
) (accountapp.Credential, error) {
	mergedAuth := map[string]any{}
	for key, value := range auth {
		mergedAuth[key] = value
	}
	for key, value := range payload {
		mergedAuth[key] = value
	}
	normalizeAuthTimes(mergedAuth, now)
	credentials["auth"] = mergedAuth
	encodedCredentials, err := json.Marshal(credentials)
	if err != nil {
		return nil, ErrRefreshFailed
	}
	document["credentials"] = encodedCredentials
	encodedDocument, err := json.Marshal(document)
	if err != nil {
		return nil, ErrRefreshFailed
	}
	refreshed, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, encodedDocument)
	if err != nil || refreshed == nil {
		return nil, ErrRefreshFailed
	}
	if refreshed.IdentitySeed() != native.IdentitySeed() {
		return nil, ErrRefreshFailed
	}
	return refreshed, nil
}

func normalizeProvider(providerID string) string {
	return strings.ToLower(strings.TrimSpace(providerID))
}
