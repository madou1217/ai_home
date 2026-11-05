// Package kiro 解析 kiro 原生凭据，并提供与刷新无关的稳定字段访问。
//
// kiro 的凭据文档有两种形态（同一外层结构，见 native_auth_json）：
//
//	oidc    —— auth.access_token / refresh_token / expires_at / region /
//	           profile_arn，外加 registration.{clientId,clientSecret,region}
//	desktop —— 只有 refresh_token / region，profileArn 在外层（social 登录）
//
// 本包只做「解析 + 判新鲜 + 应用刷新结果」，网络请求放在 adapter 层。
package kiro

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	// ErrInvalidCredential 表示 kiro 原生凭据不是可解析的 JSON 对象。
	ErrInvalidCredential = errors.New("kiro 凭据无效")
)

const (
	// ProviderID 是 kiro 的规范 Provider。
	ProviderID = "kiro"
	// FreshnessSkew 是 access token 的提前量：边界上刚好过期会让请求 403。
	FreshnessSkew = 60 * time.Second
	// DefaultRegion 是 kiro 控制面实际有 DNS 记录的默认区域。
	DefaultRegion = "us-east-1"
)

// Flavor 区分两种刷新口径。
type Flavor string

const (
	// FlavorOIDC 表示凭据带 device registration，走 AWS SSO OIDC CreateToken。
	FlavorOIDC Flavor = "oidc"
	// FlavorDesktop 表示 social 登录，只走 Kiro Desktop refreshToken。
	FlavorDesktop Flavor = "desktop"
)

// Credential 是 kiro 凭据的只读投影；document 保留原始 JSON 供刷新回写。
type Credential struct {
	accessToken  string
	refreshToken string
	expiresAt    time.Time
	region       string
	profileARN   string
	flavor       Flavor
	clientID     string
	clientSecret string
	document     map[string]json.RawMessage
}

// Grant 是一次刷新得到的新令牌。
type Grant struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	ProfileARN   string
	Region       string
}

// ParseCredential 解析 kiro 原生凭据文档。
func ParseCredential(payload []byte) (Credential, error) {
	var document map[string]json.RawMessage
	if len(payload) == 0 || json.Unmarshal(payload, &document) != nil || document == nil {
		return Credential{}, ErrInvalidCredential
	}
	var auth map[string]json.RawMessage
	if raw, exists := document["auth"]; !exists || json.Unmarshal(raw, &auth) != nil || auth == nil {
		return Credential{}, ErrInvalidCredential
	}
	credential := Credential{
		accessToken:  readString(auth["access_token"]),
		refreshToken: readString(auth["refresh_token"]),
		region:       normalizeRegion(readString(auth["region"])),
		profileARN:   firstNonEmpty(readString(auth["profile_arn"]), readString(auth["profileArn"]), readString(document["profileArn"])),
		document:     document,
	}
	if expiresAt, ok := readTime(auth["expires_at"]); ok {
		credential.expiresAt = expiresAt
	}
	var registration map[string]json.RawMessage
	if raw, exists := document["registration"]; exists && json.Unmarshal(raw, &registration) == nil && registration != nil {
		credential.clientID = firstNonEmpty(readString(registration["clientId"]), readString(registration["client_id"]))
		credential.clientSecret = firstNonEmpty(readString(registration["clientSecret"]), readString(registration["client_secret"]))
		if region := readString(registration["region"]); region != "" {
			credential.region = normalizeRegion(region)
		}
	}
	switch strings.ToLower(readString(document["flavor"])) {
	case "oidc":
		credential.flavor = FlavorOIDC
	case "desktop":
		credential.flavor = FlavorDesktop
	default:
		if credential.clientID != "" && credential.clientSecret != "" {
			credential.flavor = FlavorOIDC
		} else {
			credential.flavor = FlavorDesktop
		}
	}
	return credential, nil
}

// AccessToken 返回当前 access token。
func (credential Credential) AccessToken() string { return credential.accessToken }

// RefreshToken 返回 refresh token。
func (credential Credential) RefreshToken() string { return credential.refreshToken }

// ExpiresAt 返回 access token 的过期时间；缺失时为零值。
func (credential Credential) ExpiresAt() time.Time { return credential.expiresAt }

// Region 返回控制面区域（缺省 us-east-1）。
func (credential Credential) Region() string { return credential.region }

// ProfileARN 返回账号的 profile ARN；企业多 profile 时可能为空。
func (credential Credential) ProfileARN() string { return credential.profileARN }

// Flavor 返回刷新口径。
func (credential Credential) Flavor() Flavor { return credential.flavor }

// ClientID 返回 OIDC device registration 的 client id。
func (credential Credential) ClientID() string { return credential.clientID }

// ClientSecret 返回 OIDC device registration 的 client secret。
func (credential Credential) ClientSecret() string { return credential.clientSecret }

// IsAccessTokenFresh 判断 token 是否仍在有效期（带提前量）。
func (credential Credential) IsAccessTokenFresh(now time.Time) bool {
	if credential.accessToken == "" || credential.expiresAt.IsZero() {
		return false
	}
	return credential.expiresAt.Add(-FreshnessSkew).After(now)
}

// CanRefresh 表示凭据具备刷新所需的最小字段。
func (credential Credential) CanRefresh() bool {
	if credential.refreshToken == "" {
		return false
	}
	if credential.flavor == FlavorOIDC {
		return credential.clientID != "" && credential.clientSecret != ""
	}
	return true
}

// WithGrant 把刷新结果写回原始文档，保留其它字段（identityEvidence / database / userInfo）。
func (credential Credential) WithGrant(grant Grant) ([]byte, error) {
	if grant.AccessToken == "" {
		return nil, ErrInvalidCredential
	}
	document := make(map[string]json.RawMessage, len(credential.document))
	for key, value := range credential.document {
		document[key] = value
	}
	var auth map[string]json.RawMessage
	if raw, exists := document["auth"]; exists {
		if json.Unmarshal(raw, &auth) != nil || auth == nil {
			return nil, ErrInvalidCredential
		}
	}
	if auth == nil {
		auth = map[string]json.RawMessage{}
	}
	auth["access_token"] = mustJSON(grant.AccessToken)
	if grant.RefreshToken != "" {
		auth["refresh_token"] = mustJSON(grant.RefreshToken)
	}
	if !grant.ExpiresAt.IsZero() {
		auth["expires_at"] = mustJSON(grant.ExpiresAt.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	if grant.Region != "" {
		auth["region"] = mustJSON(normalizeRegion(grant.Region))
	}
	if grant.ProfileARN != "" {
		// 两种形态都可能携带 profileArn：auth 内是 snake_case，外层是 camelCase。
		auth["profile_arn"] = mustJSON(grant.ProfileARN)
		if _, exists := document["profileArn"]; exists {
			document["profileArn"] = mustJSON(grant.ProfileARN)
		}
	}
	document["auth"] = mustJSONMap(auth)
	// 令牌变了，身份证据的 tokenBinding 必须跟着变，否则 decoder 会拒绝整份凭据。
	if !RebindIdentityEvidence(document, auth) {
		return nil, ErrInvalidCredential
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, ErrInvalidCredential
	}
	return encoded, nil
}

func readString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func readTime(raw json.RawMessage) (time.Time, bool) {
	value := readString(raw)
	if value == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

func normalizeRegion(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return DefaultRegion
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func mustJSON(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}

func mustJSONMap(value map[string]json.RawMessage) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
