package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/application/providerruntime"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

// ansiEscape 清除官方 CLI 版本输出里的颜色序列（与 Node 侧一致）。
var ansiEscape = regexp.MustCompile("\x1b\\[[0-9;]*m")

// providerBinaryName 是 Go CLI 已知官方二进制的唯一映射。
func providerBinaryName(providerID string) string {
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "codex":
		return "codex"
	case "claude":
		return "claude"
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return "codebuddy"
	default:
		return ""
	}
}

// runProviderVersion 直接问原生 CLI（不猜版本），输出首行有效版本与二进制路径。
func runProviderVersion(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if len(arguments) != 0 {
		return fmt.Errorf("%w: 用法 aih %s version", errInvalidCommand, providerID)
	}
	binaryName := providerBinaryName(providerID)
	if binaryName == "" {
		return fmt.Errorf("%w: %s 没有已知的官方 CLI", errInvalidCommand, providerID)
	}
	path, err := providercli.ResolveBinary(providerID, binaryName)
	if err != nil {
		_, _ = fmt.Fprintf(
			runtime.stderr,
			"Native CLI '%s' (%s) not found.\n",
			providerID,
			binaryName,
		)
		return err
	}
	output := ""
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = append(os.Environ(), "NO_COLOR=1")
	raw, runErr := command.CombinedOutput()
	if runErr != nil && len(raw) == 0 {
		return fmt.Errorf("执行 %s --version 失败: %w", binaryName, runErr)
	}
	output = string(raw)
	version := ""
	for _, line := range strings.Split(ansiEscape.ReplaceAllString(output, ""), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "experimentalwarning") ||
			strings.Contains(lower, "trace-warnings") {
			continue
		}
		version = trimmed
		break
	}
	if version == "" {
		version = "(未取到版本)"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s  %s\n", providerID, version)
	_, _ = fmt.Fprintf(runtime.stdout, "  binary: %s\n", path)
	return nil
}

// runProviderHome 打印家族账号的投影诊断：路径来自 Policy，避免 CLI 与投影
// 各自维护一份目录事实。
func runProviderHome(
	ctx context.Context,
	providerID string,
	arguments []string,
	inspectRuntime commandRuntime,
) error {
	explicitID := ""
	if len(arguments) > 0 {
		explicitID = strings.TrimSpace(arguments[0])
	}
	view, err := resolveProviderAccountView(ctx, providerID, explicitID, inspectRuntime)
	if err != nil {
		return err
	}
	aiHomeDir, err := resolveAIHomeDir(inspectRuntime)
	if err != nil {
		return err
	}
	policy, ok := codebuddyfamilystorage.Policy(providerID)
	if !ok {
		return fmt.Errorf("%w: %s 没有投影策略", errInvalidCommand, providerID)
	}
	hostHome := lookupOrDefault(inspectRuntime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHome == "" {
		hostHome, _ = inspectRuntime.userHomeDir()
	}
	root := filepath.Join(
		aiHomeDir, "run", "auth-projections", providerID, view.AccountRef.String(),
	)
	root = providerruntime.ResolveCLIAuthProjectionDir(root, providerID)
	_, _ = fmt.Fprintf(
		inspectRuntime.stdout,
		"AIH home diagnostics: %s #%d\n",
		providerID,
		view.CLIAccountID.Int64(),
	)
	_, _ = fmt.Fprintf(inspectRuntime.stdout, "strategy: %s\n", policy.Mode)
	_, _ = fmt.Fprintf(
		inspectRuntime.stdout,
		"profile: %s [%s]\n",
		root,
		pathStateLabel(root),
	)
	_, _ = fmt.Fprintf(inspectRuntime.stdout, "hostHome: %s\n", homeLabel(hostHome))
	_, _ = fmt.Fprintln(inspectRuntime.stdout, "env:")
	for _, binding := range policy.Env {
		value := environmentValue(root, binding)
		if value == "" {
			continue
		}
		_, _ = fmt.Fprintf(inspectRuntime.stdout, "  %s=%s\n", binding.Key, value)
	}
	if codebuddyfamilystorage.SiteInternal(providerID) {
		_, _ = fmt.Fprintln(inspectRuntime.stdout, "  CODEBUDDY_INTERNET_ENVIRONMENT=internal")
		_, _ = fmt.Fprintln(inspectRuntime.stdout, "  CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT=internal")
	}
	_, _ = fmt.Fprintln(inspectRuntime.stdout, "paths:")
	for _, artifact := range policy.AuthArtifacts {
		target := artifactPath(root, artifact)
		if target == "" {
			continue
		}
		_, _ = fmt.Fprintf(
			inspectRuntime.stdout,
			"  auth: %s [%s]\n",
			target,
			pathStateLabel(target),
		)
	}
	for _, name := range policy.SessionEntries {
		target := filepath.Join(root, name)
		_, _ = fmt.Fprintf(
			inspectRuntime.stdout,
			"  %s: %s [%s]\n",
			name,
			target,
			pathStateLabel(target),
		)
	}
	return nil
}

// environmentValue 只渲染投影根驱动的绑定；其它基准在这里没有可靠值，跳过。
func environmentValue(root string, binding accountapp.EnvBinding) string {
	if binding.Base != accountapp.EnvBaseProjectionRoot {
		return ""
	}
	return filepath.Join(append([]string{root}, binding.Path...)...)
}

// artifactPath 计算 Home 基座认证产物的绝对路径。
func artifactPath(root string, artifact accountapp.Artifact) string {
	if artifact.Base != accountapp.ArtifactBaseHome {
		return ""
	}
	return filepath.Join(append([]string{root}, artifact.Path...)...)
}

func pathStateLabel(path string) string {
	if _, err := os.Lstat(path); err == nil {
		return "exists"
	}
	return "missing"
}

func homeLabel(hostHome string) string {
	if strings.TrimSpace(hostHome) == "" {
		return "(unknown)"
	}
	return hostHome
}
