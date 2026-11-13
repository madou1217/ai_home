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
	"github.com/madou1217/ai_home/core/providers"
	agystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/agy"
	clinestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/cline"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	codexstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codex"
	geministorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/gemini"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/grok"
	kimistorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/kimi"
	qoderstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/qoder"
	zcodestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/zcode"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

// ansiEscape 清除官方 CLI 版本输出里的颜色序列（与 Node 侧一致）。
var ansiEscape = regexp.MustCompile("\x1b\\[[0-9;]*m")

// providerBinaryName 从 Provider 合同读取官方二进制名。
//
// Node 的 AI_CLI_CONFIGS 也由同一份合同生成，新增 Provider 不需要在 CLI 里再加
// 分支；合同没有显式 BinaryName 时按 Provider ID 找同名可执行文件。
func providerBinaryName(providerID string) string {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" {
		return ""
	}
	// 家族四支共用一个 codebuddy 二进制：合同只在 codebuddy/codebuddycn 上写了
	// BinaryName，WorkBuddy 两支复用同一 CLI，不能回落到同名可执行文件。
	if codebuddyfamilystorage.IsFamilyProvider(normalized) {
		return "codebuddy"
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return ""
	}
	definition, found := catalog.Get(normalized)
	if !found || definition.CLI == nil {
		return ""
	}
	if name := strings.TrimSpace(definition.CLI.BinaryName); name != "" {
		return name
	}
	return definition.ID
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

// providerHomePolicy 返回 home 诊断使用的投影策略：家族四支 + codex。
func providerHomePolicy(providerID string) (accountapp.Policy, bool) {
	if policy, ok := codebuddyfamilystorage.Policy(providerID); ok {
		return policy, true
	}
	if providerID == "codex" {
		return codexstorage.Policy(), true
	}
	if providerID == geministorage.ProviderID {
		return geministorage.Policy(), true
	}
	if providerID == agystorage.ProviderID {
		return agystorage.Policy(), true
	}
	if providerID == grokstorage.ProviderID {
		return grokstorage.Policy(), true
	}
	if providerID == clinestorage.ProviderID {
		return clinestorage.Policy(), true
	}
	if providerID == kimistorage.ProviderID {
		return kimistorage.Policy(), true
	}
	if providerID == zcodestorage.ProviderID {
		return zcodestorage.Policy(), true
	}
	if policy, ok := qoderstorage.Policy(providerID); ok {
		return policy, true
	}
	return accountapp.Policy{}, false
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
	policy, ok := providerHomePolicy(providerID)
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
	// 会话/共享条目挂在该 Provider 的原生配置根下（Policy.ProjectionRoots[0]），
	// 不是伪 HOME 根目录；诊断必须和投影执行器同路径。
	base := policyNativeBase(root, policy)
	for _, name := range policy.SessionEntries {
		target := filepath.Join(base, name)
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

// policyNativeBase 返回共享条目所在的原生配置根。
func policyNativeBase(root string, policy accountapp.Policy) string {
	if len(policy.ProjectionRoots) == 0 {
		return root
	}
	return filepath.Join(append([]string{root}, policy.ProjectionRoots[0].From...)...)
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
	// codex 策略未显式写 Base（零值即相对 HOME），家族策略写 ArtifactBaseHome。
	if artifact.Base != "" && artifact.Base != accountapp.ArtifactBaseHome {
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
