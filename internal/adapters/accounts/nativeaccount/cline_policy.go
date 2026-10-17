package nativeaccount

import (
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// clineSlots 是 cline 自己的凭据槽位（与 Node 侧 CLINE_SLOT_IDS 同集合、同顺序）。
//
// Cline CLI 把所有 provider 的登录态写在一份文档里（`providers.<id>.settings`），
// Cline Pass 订阅会**同时**写 `cline` 与 `cline-pass` 两个槽位。账号库里只认这两个，
// 其余槽位（anthropic / openrouter / gemini …）装的是**别的 provider 的明文密钥**，
// 一律不碰——搬运它们会造成跨账号串号。
var clineSlots = []string{"cline", "cline-pass"}

// clineAccessTokenPrefix 是 WorkOS 签发标记，**属于 wire 格式的一部分**。
//
// 2026-10-14 在 Node 侧实测：`Authorization: Bearer workos:<JWT>` → 200，
// 裸 JWT → 401。因此这里**保留前缀**（与 Node 的持久化口径一致），不剥。
const clineAccessTokenPrefix = "workos:"

// clineIdentity 从 cline 原生凭据里派生稳定身份。
//
// 与 Node 侧 inspectClineCredential 同口径：认 provider 槽位里的 OAuth 记录
// （accessToken 为 `workos:<JWT>`），subject 取 JWT 的 sub（即 WorkOS 用户 id）。
// 槽位里只有 API Key、或 JWT 解析不出 sub 时判为无效凭据。
func clineIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	// 文档形态：{auth: {providers: {cline: {settings: {auth: {...}}}}}}
	root := native
	if auth := object(native["auth"]); auth != nil {
		root = auth
	}
	providers := object(root["providers"])
	if providers == nil {
		// 也接受「已经收窄到单槽位」的形态：{settings: {auth: {...}}}。
		providers = map[string]any{providerID: root}
	}
	slot := object(providers[providerID])
	if slot == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	settings := object(slot["settings"])
	if settings == nil {
		settings = slot
	}
	auth := object(settings["auth"])
	if auth == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	accessToken, ok := consistentSecretAlias(auth, "accessToken", "access_token")
	if !ok || accessToken == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	if !strings.HasPrefix(accessToken, clineAccessTokenPrefix) {
		// 没有 WorkOS 前缀的令牌上游会 401，属确定性无效凭据（Node 侧同判定）。
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	// 剥前缀只用于**本地解 JWT 声明**：前缀是 wire 格式的一部分（出网与持久化都保留），
	// 但 JWT 解析器只认裸 token。
	claims := jwtClaims(strings.TrimPrefix(accessToken, clineAccessTokenPrefix))
	if claims == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	subject := firstText(claims, "sub")
	if subject == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	// 槽位里若自带 accountId 之类的身份声明，必须与 JWT 一致（防串号）。
	for _, key := range []string{"accountId", "clineUserId", "userId"} {
		if declared := firstText(auth, key); declared != "" && declared != subject {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
	}
	return accountcore.NewNativeSubjectIdentity(providerID, subject)
}

// clineAccessToken 从已收窄的 cline 凭据载荷里取鉴权令牌（含 `workos:` 前缀）。
//
// 透传通道用它做 Bearer；前缀是 wire 格式的一部分，不能剥。
func clineAccessToken(native map[string]any) (string, bool) {
	root := native
	if auth := object(native["auth"]); auth != nil {
		root = auth
	}
	providers := object(root["providers"])
	if providers == nil {
		providers = map[string]any{"cline": root, "cline-pass": root}
	}
	for _, slotID := range clineSlots {
		slot := object(providers[slotID])
		if slot == nil {
			continue
		}
		settings := object(slot["settings"])
		if settings == nil {
			settings = slot
		}
		auth := object(settings["auth"])
		if auth == nil {
			continue
		}
		if token, ok := consistentSecretAlias(auth, "accessToken", "access_token"); ok && token != "" {
			return token, true
		}
	}
	return "", false
}
