package apps

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
)

// CLIUpdateResult reports the executable actually selected after verification.
type CLIUpdateResult struct {
	CLIPath       string
	BeforeVersion string
	Version       string
}

// UpdateCLI runs the existing official lifecycle plans synchronously. Unlike a
// WebUI job, the invoking terminal owns cancellation and waits for its children.
// No account projection, gateway connection or server config is required.
func UpdateCLI(ctx context.Context, provider string, opts Options, proxyActive bool, progress func(string)) (CLIUpdateResult, error) {
	return runCLILifecycle(ctx, provider, "update", opts, proxyActive, progress)
}

// Keep the selected Claude install channel. Unknown launchers are not permission
// to install another channel and then verify the old PATH entry by accident.
func claudeCLIUpdatePlans(installed string, opts Options, inferred []LifecyclePlan) ([]LifecyclePlan, error) {
	resolved, err := filepath.EvalSymlinks(installed)
	if err != nil {
		return nil, fmt.Errorf("无法确认 Claude 安装路径: %w", err)
	}
	path := strings.ToLower(filepath.ToSlash(resolved))
	if strings.Contains(path, "/caskroom/") || strings.Contains(path, "/cellar/") || strings.Contains(path, "/microsoft/winget/") {
		return inferred, nil
	}
	if index := strings.Index(path, "/node_modules/@anthropic-ai/claude-code/"); index >= 0 {
		// A different npm on PATH must not update a different global prefix.
		prefix := filepath.FromSlash(filepath.ToSlash(resolved)[:index])
		if resolvePlatform(opts) != platformWindows {
			if filepath.Base(prefix) != "lib" {
				return nil, fmt.Errorf("Claude npm 路径不是可确认的全局安装；请使用原安装渠道更新")
			}
			prefix = filepath.Dir(prefix)
		}
		plan := buildNpmUpdatePlan("@anthropic-ai/claude-code", opts)
		plan.Args = append(plan.Args, "--prefix", prefix)
		return filterValidPlans([]LifecyclePlan{plan}), nil
	}
	home := ResolveHostHome(opts)
	versions := strings.ToLower(filepath.ToSlash(filepath.Join(home, ".local", "share", "claude", "versions"))) + "/"
	native := strings.ToLower(filepath.ToSlash(filepath.Join(home, ".local", "bin", "claude")))
	if strings.HasPrefix(path, versions) || (resolvePlatform(opts) == platformWindows && path == native+".exe") {
		// The existing native updater moves its own launcher. Re-running the
		// bootstrap installer can leave an older selected launcher unchanged.
		return []LifecyclePlan{{ID: "claude_native_update", Label: "Claude Code 官方原生更新", Command: installed, Args: []string{"update"}, Timeout: defaultPlanTimeout}}, nil
	}
	return nil, fmt.Errorf("无法确认 Claude 安装渠道；请使用该渠道的官方更新命令，不会另装一份 CLI")
}
