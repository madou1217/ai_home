package portableaccount

import "github.com/madou1217/ai_home/core/providers"

// OverlayEnv keeps extension settings without resurrecting a competing auth
// mode or endpoint alias absent from the authoritative credential projection.
func OverlayEnv(provider string, prior, current map[string]string) map[string]string {
	reserved := map[string]bool{"CLAUDE_CODE_OAUTH_TOKEN": true, "AIH_CLAUDE_CREDENTIAL_TYPE": true, "VERTEX_AI_PROJECT_ID": true, "VERTEX_AI_LOCATION": true, "VERTEX_AI_PLACEHOLDER": true}
	if catalog, e := providers.NewCatalog(providers.BuiltinManifest()); e == nil {
		if def, ok := catalog.Get(provider); ok && def.Credentials != nil {
			for _, names := range [][]string{def.Credentials.APIKeyEnv, def.Credentials.AuthTokenEnv, def.Credentials.BaseURLEnv} {
				for _, name := range names {
					reserved[name] = true
				}
			}
		}
	}
	result := map[string]string{}
	for key, value := range prior {
		if !reserved[key] {
			result[key] = value
		}
	}
	for key, value := range current {
		result[key] = value
	}
	return result
}

// NormalizeSupplement removes alternate known credential/config containers only
// when their canonical counterpart is available. Unknown metadata is retained.
func NormalizeSupplement(provider string, prior map[string]any, current map[string]any) map[string]any {
	result := make(map[string]any, len(prior))
	for key, value := range prior {
		result[key] = value
	}
	if provider == "claude" && current["config"] != nil {
		for _, alias := range []string{"globalConfig", "oauthAccount"} {
			delete(result, alias)
		}
	}
	if provider == "codex" && current["auth"] != nil {
		for _, alias := range []string{"tokens", "auth_mode", "OPENAI_API_KEY", "last_refresh", "chatgpt_account_id"} {
			delete(result, alias)
		}
	}
	return result
}
