package sessionevents

import (
	"path/filepath"
	"strings"
)

// CanonicalizePath 将受管账号投影路径改写为对应的宿主原生路径，避免把内部投影根目录暴露给浏览器；
// 非投影路径原样返回。
func CanonicalizePath(rawPath, aiHomeDir, hostHomeDir, expectedProvider string) string {
	requested := strings.TrimSpace(rawPath)
	aiHome := strings.TrimSpace(aiHomeDir)
	hostHome := strings.TrimSpace(hostHomeDir)
	if requested == "" || aiHome == "" || hostHome == "" || !filepath.IsAbs(requested) {
		return rawPath
	}

	rel, err := filepath.Rel(filepath.Clean(aiHome), filepath.Clean(requested))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return rawPath
	}
	parts := splitNonEmpty(filepath.ToSlash(rel), "/")
	var afterPrefix []string
	switch {
	case len(parts) >= 5 && parts[0] == "run" && parts[1] == "auth-projections":
		afterPrefix = parts[2:]
	case len(parts) >= 4 && parts[0] == "profiles":
		afterPrefix = parts[1:]
	default:
		return rawPath
	}

	provider := strings.ToLower(strings.TrimSpace(afterPrefix[0]))
	wantProvider := strings.ToLower(strings.TrimSpace(expectedProvider))
	if provider == "" || (wantProvider != "" && provider != wantProvider) {
		return rawPath
	}
	tail := afterPrefix[2:]
	if len(tail) == 0 || isPrivateTail(tail) {
		return rawPath
	}
	return filepath.Join(append([]string{hostHome}, tail...)...)
}

func splitNonEmpty(value, sep string) []string {
	raw := strings.Split(value, sep)
	out := make([]string, 0, len(raw))
	for _, part := range raw {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// isPrivateTail 过滤账号私密凭据文件，绝不将其误映射为宿主路径。
func isPrivateTail(tail []string) bool {
	joined := strings.ToLower(strings.Join(tail, "/"))
	switch {
	case joined == ".claude/.credentials.json",
		strings.HasPrefix(joined, ".claude/.credentials.json."),
		joined == ".codex/auth.json",
		strings.HasPrefix(joined, ".codex/auth.json."),
		joined == ".gemini/oauth_creds.json",
		strings.HasPrefix(joined, ".gemini/oauth_creds.json."),
		joined == "electron-user-data",
		strings.HasPrefix(joined, "electron-user-data/"),
		joined == ".codebuddy/diagnostics",
		strings.HasPrefix(joined, ".codebuddy/diagnostics/"):
		return true
	default:
		return false
	}
}
