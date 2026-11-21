package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

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
	kirostorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/kiro"
	opencodestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/opencode"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	qoderstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/qoder"
	zcodestorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/zcode"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
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

// resolveProviderCLIForInfo 用与启动路径相同的安装目录事实解析官方 CLI。
// Codex 的受管运行时始终由 providercli 判定，其余 Provider 先查安装器目录
// （例如 agy 的 ~/.local/bin），再回落 PATH。
func resolveProviderCLIForInfo(
	providerID string,
	binaryName string,
	runtime commandRuntime,
) (string, error) {
	if strings.EqualFold(strings.TrimSpace(providerID), "codex") {
		return providercli.ResolveBinary(providerID, binaryName)
	}
	hostHome := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHome == "" {
		if home, err := runtime.userHomeDir(); err == nil {
			hostHome = home
		}
	}
	aiHome, _ := resolveAIHomeDir(runtime)
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if found && name != "" {
			environment[name] = value
		}
	}
	if path := apps.ResolveBinaryPath(providerID, binaryName, apps.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Env:         environment,
	}); path != "" {
		return path, nil
	}
	return providercli.ResolveBinary(providerID, binaryName)
}

// runProviderVersion 直接问原生 CLI（不猜版本），输出首行有效版本与二进制路径。
func runProviderVersion(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if providerID == "codex" && len(arguments) > 0 && arguments[0] == "--raw" {
		return runCodexRawVersion(ctx, arguments[1:], runtime)
	}
	if len(arguments) != 0 {
		return fmt.Errorf("%w: 用法 aih %s version", errInvalidCommand, providerID)
	}
	binaryName := providerBinaryName(providerID)
	if binaryName == "" {
		return fmt.Errorf("%w: %s 没有已知的官方 CLI", errInvalidCommand, providerID)
	}
	path, err := resolveProviderCLIForInfo(providerID, binaryName, runtime)
	if err != nil {
		_, _ = fmt.Fprintf(
			runtime.stderr,
			"[aih] 未找到 %s 官方 CLI（%s）：当前 PATH 与常见安装目录中都没有它。\n",
			providerID,
			binaryName,
		)
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 安装：aih %s install；或直接运行 aih %s，按提示一键安装。\n", providerID, providerID)
		return cliExitCode{code: 1}
	}
	output := ""
	command := exec.CommandContext(ctx, path, "--version")
	command.Env = append(os.Environ(), "NO_COLOR=1")
	raw, runErr := command.CombinedOutput()
	if runErr != nil && (providerID == "codex" || len(raw) == 0) {
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
		if providerID == "codex" {
			return fmt.Errorf("官方 Codex CLI 未返回版本；请在工具箱的应用管理中检查或重新安装")
		}
		version = "(未取到版本)"
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s  %s\n", providerID, version)
	_, _ = fmt.Fprintf(runtime.stdout, "  binary: %s\n", path)
	return nil
}

// codexVersionExit preserves native diagnostic exit status without an AIH suffix.
type codexVersionExit int

func (code codexVersionExit) Error() string { return "" }
func (code codexVersionExit) ExitCode() int { return int(code) }
func (code codexVersionExit) SilentExit()   {}

// runCodexRawVersion is the CLI wrapper's bounded diagnostic adapter. It does
// not read account/default state, project config, or run arbitrary native argv.
func runCodexRawVersion(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 1 && arguments[0] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-codex-raw-version-v1")
		return err
	}
	if len(arguments) != 1 || (arguments[0] != "--version" && arguments[0] != "-V") {
		return fmt.Errorf("%w: raw Codex version requires --version or -V", errInvalidCommand)
	}
	// Canonical selection retains explicit override, authoritative managed
	// current/tombstone/repair and discovery-hint precedence in one place.
	path, err := providercli.ResolveBinary("codex", "codex")
	if err != nil {
		return err
	}
	// Preserve the CLI helper's admission against an interrupted host default
	// transaction; a version query does not authorize recovery or config writes.
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		host := strings.TrimSpace(os.Getenv("HOME"))
		if host == "" {
			host = strings.TrimSpace(os.Getenv("USERPROFILE"))
		}
		if host != "" {
			home = filepath.Join(host, providerroot.ConfigDir("codex"))
		}
	}
	if err = codexpreferences.CheckHostReady(home); err != nil {
		return err
	}
	command := exec.CommandContext(ctx, path, arguments[0])
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = os.Environ()
	if err = command.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			if exit.ExitCode() >= 0 {
				return codexVersionExit(exit.ExitCode())
			}
			if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				return codexVersionExit(128 + int(status.Signal()))
			}
		}
		return err
	}
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
	if providerID == kirostorage.ProviderID {
		return kirostorage.Policy(), true
	}
	if providerID == opencodestorage.ProviderID {
		return opencodestorage.Policy(), true
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
