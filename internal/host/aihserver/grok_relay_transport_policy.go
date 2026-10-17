package aihserver

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
)

// grokRelayTransportPolicy 判断领域凭据能否由 grok 透传通道承载。
//
// 与家族/cline/kimi 同一口径：只有原生登录态（带 access token 或 API Key）能走透传。
// grok 的 API Key 账号本身就是它的原生形态，因此两种都接受。
type grokRelayTransportPolicy struct{}

// SupportsCredential 返回透传通道能否安全承载该凭据。
func (grokRelayTransportPolicy) SupportsCredential(credential accountapp.Credential) bool {
	if credential == nil || credential.ProviderID() != grokrelay.ProviderID {
		return false
	}
	_, err := grokrelay.AccessTokenFromCredential(credential)
	return err == nil
}
