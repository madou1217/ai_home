package sessionevents

import (
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
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

// privateTails 是各 Provider 声明的凭据与私密状态路径（已小写）。
//
// 根事实来自 Provider 合同（经 storagepolicy 展开 NativeRoot/GlobalDir），
// 新增 Provider 只要声明 AuthArtifacts / PrivateArtifacts 就自动生效。
var privateTails = buildPrivateTails()

func buildPrivateTails() []string {
	tails := []string{}
	seen := map[string]struct{}{}
	for _, provider := range storagepolicy.Names() {
		policy := storagepolicy.Get(provider)
		if policy == nil {
			continue
		}
		artifacts := make([]storagepolicy.Artifact, 0, len(policy.AuthArtifacts)+len(policy.PrivateArtifacts))
		artifacts = append(artifacts, policy.AuthArtifacts...)
		artifacts = append(artifacts, policy.PrivateArtifacts...)
		for _, artifact := range artifacts {
			joined := strings.ToLower(strings.Join(artifact.Path, "/"))
			if joined == "" {
				continue
			}
			if _, exists := seen[joined]; exists {
				continue
			}
			seen[joined] = struct{}{}
			tails = append(tails, joined)
		}
	}
	return tails
}

// isPrivateTail 过滤账号私密凭据文件，绝不将其误映射为宿主路径。
// 目录条目同时拒绝其下所有文件；文件条目同时拒绝 "<name>.<suffix>" 备份变体。
func isPrivateTail(tail []string) bool {
	joined := strings.ToLower(strings.Join(tail, "/"))
	for _, expected := range privateTails {
		if joined == expected ||
			strings.HasPrefix(joined, expected+".") ||
			strings.HasPrefix(joined, expected+"/") {
			return true
		}
	}
	return false
}
