package webuiaccountconfigapi

import (
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// extraProjectionFiles 是各 provider 在投影目录里额外值得展示的原生文件，
// 与 Node account-config-view.js 的 EXTRA_PROJECTION_FILES 一致。
var extraProjectionFiles = map[string][]string{
	"kiro": {".kiro/settings/cli.json", ".aih-kiro-auth-binding", "data.sqlite3"},
}

// credentialRelativePaths 与 Node credential-layout.js 的 collectCredentialRelativePaths 一致。
func credentialRelativePaths(provider string) []string {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if normalized == "" {
		return nil
	}
	hiddenDir := "." + normalized
	if normalized == "agy" {
		hiddenDir = ".gemini"
	}
	paths := []string{
		hiddenDir + "/auth.json",
		hiddenDir + "/oauth_creds.json",
		hiddenDir + "/oauth.json",
		hiddenDir + "/token.json",
		hiddenDir + "/tokens.json",
		hiddenDir + "/credentials.json",
		hiddenDir + "/.credentials.json",
		hiddenDir + "/settings.json",
		hiddenDir + "/google_accounts.json",
	}
	switch normalized {
	case "agy":
		paths = append(paths,
			hiddenDir+"/antigravity-cli/antigravity-oauth-token",
			hiddenDir+"/antigravity-cli/email.cache",
		)
	case "opencode":
		paths = append(paths, ".local/share/opencode/auth.json")
	case "kiro":
		paths = append(paths, "data.sqlite3")
	case "kimi":
		paths = append(paths, ".kimi-code/credentials/kimi-code.json", "credentials/kimi-code.json")
	case "qoder":
		paths = append(paths, "qoder-cli-credentials.json", ".keychain-salt")
	case "qodercn":
		paths = append(paths, "qoder-cli-cn-credentials.json", ".keychain-salt")
	case "zcode":
		paths = append(paths, ".zcode/v2/credentials.json", ".zcode/v2/config.json", "v2/credentials.json", "v2/config.json")
	case "cline":
		paths = append(paths, ".cline/data/settings/providers.json", "data/settings/providers.json")
	}
	return paths
}

// projectionCandidates 复刻 Node：通用凭据路径 + CLI 合同里的 configFile +
// provider 专属补充；去重、统一斜杠、去掉绝对路径与 .. 段。
func projectionCandidates(provider string, catalog *providers.Catalog) []string {
	paths := append([]string(nil), credentialRelativePaths(provider)...)
	if catalog != nil {
		if definition, ok := catalog.Get(provider); ok && definition.CLI != nil && definition.CLI.ConfigFile != "" {
			globalDir := definition.CLI.GlobalDir
			if globalDir == "" {
				globalDir = "." + provider
			}
			parts := make([]string, 0, 3)
			for _, part := range []string{globalDir, definition.CLI.ConfigSubDir, definition.CLI.ConfigFile} {
				if part != "" {
					parts = append(parts, part)
				}
			}
			paths = append(paths, strings.Join(parts, "/"))
		}
	}
	paths = append(paths, extraProjectionFiles[provider]...)

	result := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, candidate := range paths {
		normalized := strings.ReplaceAll(strings.TrimSpace(candidate), "\\", "/")
		normalized = strings.TrimLeft(normalized, "/")
		if normalized == "" {
			continue
		}
		unsafe := false
		for _, segment := range strings.Split(normalized, "/") {
			if segment == ".." {
				unsafe = true
				break
			}
		}
		if unsafe {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}
