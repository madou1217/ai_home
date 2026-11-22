package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/host/aihaccount"
	"github.com/madou1217/ai_home/internal/host/aihcli"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const (
	managementHTTPTimeout = 10 * time.Second
)

// defaultGatewayBaseURL 的主机与端口来自 application/serverconfig 的共享监听契约。
var defaultGatewayBaseURL = serverconfig.BaseURL(serverconfig.DefaultHost, serverconfig.DefaultPort, "")

var errInvalidCommand = errors.New("aih 命令无效")

// providerApplication 是命令入口依赖的最小 Host 端口。
type providerApplication interface {
	Run(
		ctx context.Context,
		providerID string,
		arguments []string,
		gateway aihcli.GatewayConfig,
	) error
	Close() error
}

// commandRuntime 隔离环境、用户目录、终端 I/O 和 Composition Root 创建。
type commandRuntime struct {
	lookupEnv     func(string) (string, bool)
	userHomeDir   func() (string, error)
	stdin         io.Reader
	stdout        io.Writer
	stderr        io.Writer
	managementAPI managementapi.HTTPClient
	newApp        func(context.Context, aihcli.Options) (providerApplication, error)
	// newAccountApp 仅为旧测试替身保留；生产账号命令全部使用 Management API。
	newAccountApp func(context.Context, aihaccount.Options) (accountApplication, error)
}

// defaultCommandRuntime 绑定真实操作系统环境和 Go Composition Root。
func defaultCommandRuntime() commandRuntime {
	return commandRuntime{
		lookupEnv:   os.LookupEnv,
		userHomeDir: os.UserHomeDir,
		stdin:       os.Stdin,
		stdout:      os.Stdout,
		stderr:      os.Stderr,
		managementAPI: &http.Client{
			Timeout: managementHTTPTimeout,
		},
		newApp: func(ctx context.Context, options aihcli.Options) (providerApplication, error) {
			return aihcli.New(ctx, options)
		},
	}
}

// run 只解析 aih 根命令；Provider 参数由官方 CLI 和双模式意图解析器处理。
func run(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if ctx == nil || runtime.lookupEnv == nil || runtime.userHomeDir == nil ||
		runtime.stdin == nil || runtime.stdout == nil || runtime.stderr == nil ||
		runtime.managementAPI == nil ||
		runtime.newApp == nil {
		return errInvalidCommand
	}
	if len(arguments) == 0 || isRootHelp(arguments[0]) {
		writeUsage(runtime.stdout)
		return nil
	}
	providerID := arguments[0]
	// 发行包的 install.sh / deploy-server 都以 `aih install` 作为唯一安装入口。
	if providerID == "install" {
		return runInstallCommand(ctx, arguments[1:], runtime)
	}
	if providerID == "__complete" {
		return runCompleteEntry(arguments[1:], runtime)
	}
	if providerID == "__suggest" {
		return runSuggestEntry(arguments[1:], runtime)
	}
	if providerID == "__learn" {
		return runLearnEntry(arguments[1:], runtime)
	}
	if providerID == "__remote_ws__" {
		return runRemoteWorkspace(arguments[1:], runtime)
	}
	if providerID == "__usage-probe" {
		return runUsageProbe(arguments[1:], runtime)
	}
	if providerID == "__ssh_mcp__" {
		return runSSHMCPServer(arguments[1:], runtime)
	}
	if providerID == "__background" {
		return runBackgroundSupervisorCommand(arguments[1:], runtime)
	}
	// 模型查看先于任何原生启动分流，不能把 models 当作原生提示词。
	if handled, err := runModelsCommand(ctx, arguments, runtime); handled {
		return err
	}
	// 外部 harness（pi / dsh / dsh-tui）是 `aih <id>` 的一等命令，先于 Provider
	// 合同分流：它们没有上游协议，不能按未知 Provider 处理。Go 直接启动，不再
	// 转交 Node 旧入口（旧委派会让 aih 在子 shell 里短路成「启动请求无效」）。
	if harness, external := harnesses.Get(providerID); external {
		return runHarnessShorthand(harness.ID, arguments, runtime)
	}
	// `aih <数字> …`：数字是 CLI 账号编号，只有恰好一个 Provider 拥有时才可解释。
	// 多个 Provider 都存在同一编号时明确报未知命令，不猜归属。
	if isNumericToken(providerID) {
		if provider, resolved := resolveUniqueProviderForCLIAccountID(ctx, providerID, runtime); resolved {
			return runProviderLaunch(ctx, provider, arguments, runtime)
		}
		return runUnknownRootCommand(providerID, runtime)
	}
	if providerID == "plugin" {
		return runPlugin(ctx, arguments[1:], runtime)
	}
	if providerID == "desktop" {
		return runDesktop(ctx, arguments[1:], runtime)
	}
	if providerID == "agent" {
		return runAgent(arguments[1:], runtime)
	}
	if providerID == "claim" {
		return runClaim(ctx, arguments[1:], runtime)
	}
	if providerID == "edge" {
		return runEdge(ctx, arguments[1:], runtime)
	}
	if providerID == "shell" {
		return runShell(arguments[1:], runtime)
	}
	if providerID == "ssh" {
		return runSSH(arguments[1:], runtime)
	}
	if providerID == "ssh-clipboard" {
		return runSSHClipboard(arguments[1:], runtime)
	}
	if providerID == "clip-agent" {
		return runClipAgent(arguments[1:], runtime)
	}
	if providerID == "proxy" {
		return runProxyCommand(ctx, arguments[1:], runtime)
	}
	if providerID == "harness" {
		return runHarness(arguments[1:], runtime)
	}
	if providerID == "skill" {
		return runSkill(ctx, arguments[1:], runtime)
	}
	if providerID == "mcp" {
		return runMCP(ctx, arguments[1:], runtime)
	}
	if providerID == "native" && len(arguments) >= 2 && arguments[1] == "plugin" {
		return runNativePlugin(ctx, arguments[2:], runtime)
	}
	if providerID == "native" {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] Usage: aih native plugin ...")
		return cliExitCode{code: 1}
	}
	if providerID == "provider" {
		return runProviderCommand(ctx, arguments, runtime)
	}
	if providerID == "zcode-url" {
		return runZcodeURL(ctx, arguments, runtime)
	}
	if providerID == "update" {
		return runUpdate(ctx, arguments[1:], runtime)
	}
	if providerID == "backup" {
		return runBackup(ctx, arguments[1:], runtime)
	}
	if providerID == "peer" {
		return runPeer(ctx, arguments[1:], runtime)
	}
	if providerID == "claude" && !commandNeedsNativeStore(providerID, arguments[1:]) {
		configured, configErr := withClaudeGatewayConfig(ctx, runtime)
		if configErr != nil {
			return configErr
		}
		runtime = configured
	}
	if providerID == "__codex-cli-startup" {
		return runCodexCLIStartup(ctx, arguments[1:], runtime)
	}
	if providerID == "__codex-cli-app-server" {
		return runCodexCLIAppServer(ctx, arguments[1:], runtime)
	}
	if providerID == "__codex-app-server-stdio" {
		return runCodexAppServerStdio(ctx, arguments[1:], runtime)
	}
	if providerID == "__codex-cli-resume" {
		return runCodexCLIResume(ctx, arguments[1:], runtime)
	}
	if providerID == "__codex-default-cli" {
		return runCodexDefaultCLI(ctx, arguments[1:], runtime)
	}
	if providerID == "__claude-desktop-credential" {
		return runClaudeDesktopCredential(ctx, arguments[1:], runtime)
	}
	if providerID == "__desktop-client-paths" {
		if len(arguments) != 1 {
			return errInvalidCommand
		}
		return runDesktopClientPaths(ctx, runtime)
	}
	if providerID == "__codex-desktop-detect" {
		if len(arguments) != 1 {
			return errInvalidCommand
		}
		return runCodexDesktopDetect(ctx, runtime)
	}
	if providerID == "__claude-desktop-detect" && len(arguments) == 1 {
		return runClaudeDesktopDetect(ctx, runtime)
	}
	if providerID == "__claude-desktop-launch" {
		if len(arguments) != 1 {
			return errInvalidCommand
		}
		return runClaudeDesktopLaunch(ctx, runtime)
	}
	if providerID == "__claude-desktop-config" && len(arguments) == 1 {
		return runClaudeDesktopConfig(ctx, runtime)
	}
	if providerID == "__provider-hook-config" && len(arguments) == 1 {
		return runProviderHookConfig(ctx, runtime)
	}
	if providerID == "__backup-accounts" {
		return runBackupAccounts(ctx, arguments[1:], runtime)
	}
	if providerID == "__upstream-rules" {
		return runUpstreamRules(ctx, arguments[1:], runtime)
	}
	if providerID == "failure-policy" {
		return runFailurePolicy(ctx, arguments[1:], runtime)
	}
	if providerID == accountCommandName {
		return runAccount(ctx, arguments[1:], runtime)
	}
	// Provider 限定的备份命令由 Go 执行：请求只带该 Provider，不从旧的
	// CLI 规划器绕行。
	if len(arguments) >= 2 && arguments[1] == "export" {
		return runProviderExport(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "import" {
		return runProviderImport(ctx, providerID, arguments[2:], runtime)
	}
	// aih ls [id] [--scope ...]：全量账号列表。
	if providerID == "ls" {
		return runGlobalAccountList(ctx, arguments[1:], runtime)
	}
	// aih ss|sessions --list/-l/--detail：只读列出全部受管持久会话。
	if providerID == "ss" || providerID == "sessions" {
		return runGlobalSessions(ctx, arguments[1:], runtime)
	}
	if providerID == "__terminal-sessions" {
		return runTerminalSessionsEntry(ctx, arguments[1:], runtime)
	}
	// Preserve the native boundary before interpreting any provider action. The
	// launch intent parses only the prefix and strips the marker at its boundary.
	if aihcli.SupportsNativeCLI(providerID) && containsArgument(arguments[1:], "--") {
		return runProviderLaunch(ctx, providerID, arguments[1:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "update" && providerBinaryName(providerID) != "" {
		return runProviderUpdate(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "install" && providerBinaryName(providerID) != "" {
		return runProviderInstall(ctx, providerID, arguments[2:], runtime)
	}
	if writeSessionVerbHelp(providerID, arguments, runtime) {
		return nil
	}
	// aih codex set-mobile|unset-mobile：Codex App 账号绑定（服务端写 hook state）。
	if len(arguments) >= 2 && (arguments[1] == "set-mobile" || arguments[1] == "unset-mobile") {
		return runProviderMobile(ctx, providerID, arguments[1:], runtime)
	}
	if providerID == "codex" && len(arguments) >= 2 && arguments[1] == "gateway-auth" {
		return runCodexGatewayAuth(ctx, arguments[2:], runtime)
	}
	if providerID == "codex" && len(arguments) >= 2 && arguments[1] == "effort" {
		return runCodexEffort(arguments[2:], runtime)
	}
	if providerID == "codex" && len(arguments) >= 2 && arguments[1] == "model" {
		return runCodexModel(arguments[2:], runtime)
	}
	// aih codex policy [show|set <sandbox>]：app-state 的 policy:exec。
	if len(arguments) >= 2 && arguments[1] == "policy" {
		return runProviderPolicy(ctx, providerID, arguments[2:], runtime)
	}
	// aih <family> [<账号>] resume|fork ... → 官方 CLI 的 --resume/--continue；
	// 家族没有 fork 入口时在这里明确拒绝，不把动词当消息发给 CLI。
	if codebuddyfamilystorage.IsFamilyProvider(providerID) {
		// `--` 之后是原生参数逃生门：不再解析 aih 统一动词。
		stripped, escaped := stripNativeEscapeMarker(arguments)
		arguments = stripped
		if !escaped {
			rewritten, handled, verbErr := rewriteFamilySessionVerb(ctx, providerID, arguments, runtime)
			if handled {
				if verbErr != nil {
					return verbErr
				}
				arguments = rewritten
			}
		}
	}
	// 终端图标对所有 Provider 通用：图标与 GUID 都来自 Provider 合同与内嵌资产，
	// 不依赖账号投影或家族站点，因此不受家族分支限制。
	if len(arguments) >= 2 && (arguments[1] == "terminal-icon" || arguments[1] == "terminal-icons") {
		return runProviderTerminalIcon(ctx, providerID, arguments[2:], runtime)
	}
	// 删除投影已全量迁入 Go deletionprojection（不再保留外部钩子表），
	// 所有 Provider 的 delete/deleteall 都由 Go Server 承担。
	if len(arguments) >= 2 && arguments[1] == "delete" {
		return runProviderDelete(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) == 2 && (arguments[1] == "deleteall" || arguments[1] == "delete-all") {
		return runProviderDelete(ctx, providerID, []string{"deleteall"}, runtime)
	}
	// 本机账号扫描对所有 Provider 是同一份数据面；Provider 名只用于输出上下文。
	if len(arguments) >= 2 && arguments[1] == "detect" {
		return runProviderDetect(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && codebuddyfamilystorage.IsFamilyProvider(providerID) {
		switch arguments[1] {
		case "detect":
			return runProviderDetect(ctx, providerID, arguments[2:], runtime)
		}
	}
	// 自动换号是全局设置（额度事实与账号池跨 Provider 共用），任何 Provider 的
	// 入口都读写同一份 config:usage，不需要限定家族。
	if len(arguments) >= 2 && arguments[1] == "auto-switch" {
		return runProviderAutoSwitch(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "version" && providerBinaryName(providerID) != "" {
		return runProviderVersion(ctx, providerID, arguments[2:], runtime)
	}
	if _, ok := providerHomePolicy(providerID); ok {
		if len(arguments) >= 2 && arguments[1] == "home" {
			return runProviderHome(ctx, providerID, arguments[2:], runtime)
		}
		if len(arguments) == 3 && arguments[2] == "home" {
			return runProviderHome(ctx, providerID, []string{arguments[1]}, runtime)
		}
	}
	if len(arguments) >= 3 && codebuddyfamilystorage.IsFamilyProvider(providerID) &&
		isNumericAccountToken(arguments[1]) &&
		(containsArgument(arguments[2:], "--restart-client") ||
			containsArgument(arguments[2:], "--force-quit-client")) {
		return runProviderRestart(ctx, providerID, arguments[1], runtime)
	}
	if len(arguments) >= 2 && (arguments[1] == "usage" || arguments[1] == "stats" || arguments[1] == "--usage") {
		return runProviderUsage(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "ls" {
		return runProviderList(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "login" {
		return runProviderLogin(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && (arguments[1] == "set-default" || arguments[1] == "unset-default") {
		return runProviderDefaultCommand(ctx, providerID, arguments[1:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "sessions" && (containsArgument(arguments[2:], "--history") || containsArgument(arguments[2:], "--all")) {
		return runProviderSessionsHistory(ctx, providerID, arguments[2:], runtime)
	}
	if len(arguments) >= 2 && arguments[1] == "sessions" {
		return runProviderSessionsList(ctx, providerID, arguments[2:], runtime)
	}
	// Codex resume may target a thread whose prior process still owns the
	// global writer lock. Resolve the exact thread before native argv rewrite.
	if providerID == "codex" && len(arguments) >= 2 {
		if threadID, ok := codexResumeThreadID(arguments); ok {
			if err := takeoverCodexThreadIfNeeded(threadID, runtime); err != nil {
				return err
			}
		}
	}
	if providerID == "help" {
		if len(arguments) == 2 && isCLIProvider(arguments[1]) {
			writeProviderUsage(runtime.stdout, arguments[1])
			return nil
		}
		if len(arguments) == 2 && arguments[1] == accountCommandName {
			writeAccountUsage(runtime.stdout)
			return nil
		}
		if len(arguments) != 1 {
			return errInvalidCommand
		}
		writeUsage(runtime.stdout)
		return nil
	}
	if len(arguments) == 2 && isCLIProvider(providerID) &&
		isRootHelp(arguments[1]) {
		writeProviderUsage(runtime.stdout, providerID)
		return nil
	}
	// 非家族但已由 Go 承接原生启动的 Provider：resume/fork 统一动词按合同旗标
	// 改写（家族在上面已单独处理）。未声明的能力明确拒绝，不把动词当消息发出去。
	if !codebuddyfamilystorage.IsFamilyProvider(providerID) && aihcli.SupportsNativeCLI(providerID) {
		stripped, escaped := stripNativeEscapeMarker(arguments)
		arguments = stripped
		if !escaped {
			rewritten, handled, verbErr := rewriteGoLaunchSessionVerb(ctx, providerID, arguments, runtime)
			if handled {
				if verbErr != nil {
					return verbErr
				}
				arguments = rewritten
			}
		}
	}
	// 未知根命令不再回落 Node 入口：给出同一条黄色提示与根用法，退出码 2，
	// 与 shell 拼写纠正集成保持同一契约。
	if !isRegisteredProvider(providerID) {
		return runUnknownRootCommand(providerID, runtime)
	}
	return runProviderLaunch(ctx, providerID, arguments[1:], runtime)
}

// isRegisteredProvider 判断根命令位是否是 Provider 合同里的名字。
func isRegisteredProvider(providerID string) bool {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return false
	}
	_, found := catalog.Get(strings.ToLower(strings.TrimSpace(providerID)))
	return found
}

// runProviderLaunch composes the same native/relay execution path for both the
// explicit escape and normal parsed commands; it never dispatches management verbs.
func runProviderLaunch(ctx context.Context, providerID string, arguments []string, runtime commandRuntime) error {
	// 环境变量缺失时回落到本地 config:server（显式值永远优先；远端不继承本机密钥）。
	runtime = withLocalGatewayDefaults(ctx, runtime)
	baseURL := lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_BASE_URL", defaultGatewayBaseURL)
	clientKey := lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_API_KEY", "")
	managementKey := lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY", "")
	if catalog, catalogErr := providers.NewCatalog(providers.BuiltinManifest()); catalogErr == nil {
		if intent, intentErr := providerlaunch.ParseLaunchIntent(catalog, providerID, arguments); intentErr == nil &&
			intent.Mode() == providerlaunch.LaunchModeGatewayRelay &&
			intent.HasPinnedAccount() &&
			intent.RelayProviderID() != intent.ClientProviderID() {
			rewritten, aliasErr := resolveHarnessAliasArgs(ctx, runtime.managementAPI, baseURL, managementKey, intent.RelayProviderID(), arguments)
			if aliasErr != nil {
				return aliasErr
			}
			arguments = rewritten
		}
	}
	needsNativeStore := commandNeedsNativeStore(providerID, arguments)
	// 网关档也需要数据根：CodeBuddy 家族的 models.json 投影落在
	// <aiHome>/run/codebuddy-gateway，不能等 Native Direct 分支才解析。
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	var claudePreflight providercli.ClaudePreflight
	if providerID == "claude" && aiHomeDir != "" {
		claudePreflight = resolveClaudePreflight(ctx, runtime, aiHomeDir)
	}
	var gatewayAccounts providerlaunch.GatewayAccountResolver
	if !needsNativeStore {
		gatewayAccounts, err = newManagementGatewayAccountResolver(
			runtime.managementAPI,
			baseURL,
			managementKey,
		)
		if err != nil {
			return fmt.Errorf("初始化远端 Gateway 账号解析器失败: %w", err)
		}
	}
	app, err := runtime.newApp(ctx, aihcli.Options{
		AIHomeDir:       aiHomeDir,
		GatewayAccounts: gatewayAccounts,
		Stdin:           runtime.stdin,
		Stdout:          runtime.stdout,
		Stderr:          runtime.stderr,
		ClaudePreflight: claudePreflight,
		// Codex 偏好属于宿主用户：投影 HOME 下也读写宿主 ~/.codex。
		CodexHomeDir: sharedCodexHomeDir(runtime),
	})
	if err != nil {
		return fmt.Errorf("初始化 Go CLI 失败: %w", err)
	}
	// 家族交互式启动：先把当前终端切到该 Provider 的 Profile/标题（与 Node 的
	// prepareCurrentTerminalProviderIcon 同语义）。非 TTY 自动跳过。
	if codebuddyfamilystorage.IsFamilyProvider(providerID) {
		prepareFamilyTerminalIcon(runtime, providerID)
	}
	gateway := aihcli.GatewayConfig{
		BaseURL:   baseURL,
		ClientKey: clientKey,
	}
	runErr := app.Run(ctx, providerID, arguments, gateway)
	closeErr := app.Close()
	return errors.Join(runErr, closeErr)
}

// isNumericAccountToken 判断 token 是否是 CLI 数字别名。
func isNumericAccountToken(value string) bool {
	text := strings.TrimSpace(value)
	if text == "" {
		return false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

// commandNeedsNativeStore 使用同一套 LaunchIntent 解析，避免命令入口重新猜测模式。
func commandNeedsNativeStore(providerID string, arguments []string) bool {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return true
	}
	intent, err := providerlaunch.ParseLaunchIntent(catalog, providerID, arguments)
	return err == nil && intent.Mode() == providerlaunch.LaunchModeNativeDirect
}

// resolveAIHomeDir 复用全局 AIH_HOME_DIR；不创建任何 Provider 或账号级 HOME。
// Go 侧只认规范名字，不提供 AIH_HOME / AI_HOME 别名 fallback。
func resolveAIHomeDir(runtime commandRuntime) (string, error) {
	value, found := runtime.lookupEnv("AIH_HOME_DIR")
	if !found || strings.TrimSpace(value) == "" {
		userHome, err := runtime.userHomeDir()
		if err != nil || strings.TrimSpace(userHome) == "" {
			return "", errInvalidCommand
		}
		value = filepath.Join(userHome, ".ai_home")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", errInvalidCommand
	}
	return absolute, nil
}

// lookupOrDefault 保留敏感环境原值，让下层严格校验空白和控制字符。
func lookupOrDefault(
	lookupEnv func(string) (string, bool),
	name string,
	fallback string,
) string {
	value, found := lookupEnv(name)
	if !found {
		return fallback
	}
	return value
}

// isRootHelp 只识别 aih 根帮助，不吞掉 Provider 自身的 --help。
func isRootHelp(argument string) bool {
	return argument == "-h" || argument == "--help"
}

// isCLIProvider 报告本 CLI 是否为该 Provider 提供「官方客户端命令」。
//
// 这是一个比「Provider 是否存在」更窄的问题：它同时要求该 Provider 有原生客户端
// 启动路径与可打印的用法/帮助文本，因此只列 codex / claude / codebuddy 家族。
// 判断「Provider 是否存在、服务端是否认识」请用 isKnownProvider（按 Provider
// 合同 Catalog 判定），不要把本函数当存在性检查用——那样会让服务端支持的
// Provider（如 gemini）在 CLI 侧被先一步判成非法。
func isCLIProvider(providerID string) bool {
	return providerID == "codex" || providerID == "claude" ||
		codebuddyfamilystorage.IsFamilyProvider(providerID)
}

// writeUsage 说明当前已实现的双模式命令和共享状态约束。
func writeUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> [provider_args...]                  # Gateway 账号池")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> relay [account_id] [provider_args...] # Gateway 同 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <client> relay <provider> <account_id> [provider_args...] # Gateway 跨 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih <codex|claude> <account_id> [provider_args...]       # Native Direct")
	_, _ = fmt.Fprintln(output, "  aih <provider> models [accountID|accountRef] [--json]    # 只读目标 Server 模型目录")
	_, _ = fmt.Fprintln(output, "  aih <harness> models [accountRef] [--json]              # 只读 harness 可选模型")
	_, _ = fmt.Fprintln(output, "  aih provider models <provider> [accountID|accountRef] [--json]")
	_, _ = fmt.Fprintln(output, "  aih harness <id> models [--provider <p>] [--account <n|ref>] [--json]")
	_, _ = fmt.Fprintln(output, "  "+accountUsageLine())
	_, _ = fmt.Fprintln(output, "  aih plugin <command> [options]                         # 插件打包、信任根与启停")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "共享状态:")
	_, _ = fmt.Fprintln(output, "  Claude 继承官方 CLAUDE_CONFIG_DIR；Codex Gateway 继承官方 CODEX_HOME。")
	_, _ = fmt.Fprintln(output, "  Codex Native Direct 的 OAuth 账号使用账号级 CODEX_HOME（auth 私有），sessions/sqlite 仍共享宿主。")
	_, _ = fmt.Fprintln(output, "  AIH 不创建账号级 HOME；Native Direct 只读本地 AIH_HOME_DIR，Gateway Relay 只连接目标 Server。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_HOME_DIR")
	_, _ = fmt.Fprintf(output, "  AIH_SERVER_BASE_URL（默认 %s）\n", defaultGatewayBaseURL)
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_API_KEY（仅 Gateway 模式必需）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（账号管理和固定 Relay 数字别名解析必需）")
	_, _ = fmt.Fprintln(output, "  AIH_CODEX_BINARY / AIH_CLAUDE_BINARY（可选官方 CLI 路径）")
}

// writeProviderUsage 在打开数据库或连接 Server 前说明 AIH 模式边界。
func writeProviderUsage(output io.Writer, providerID string) {
	if providerID == "claude" {
		_, _ = fmt.Fprintln(output, "AIH Claude 用法:")
		_, _ = fmt.Fprintf(output, "  aih %s models [accountID|accountRef] [--json]  # 只读目标 Server 模型目录\n", providerID)
		_, _ = fmt.Fprintln(output, "  aih claude [claude_args...]                    # Gateway 账号池")
		_, _ = fmt.Fprintln(output, "  aih claude relay <account_id> [claude_args...] # Gateway 固定账号")
		_, _ = fmt.Fprintln(output, "  aih claude <account_id> [claude_args...]       # Native Direct")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "模式说明:")
		_, _ = fmt.Fprintln(output, "  Gateway 账号池按请求中的真实模型公平征召账号；Claude 官方客户端的 OAuth 走原生 Relay 保留客户端证明，")
		_, _ = fmt.Fprintln(output, "  其余凭据与跨协议客户端走 Canonical Adapter。")
		_, _ = fmt.Fprintln(output, "  Gateway 固定账号仍经 Server Relay，但不会失败换号。")
		_, _ = fmt.Fprintln(output, "  Native Direct 使用指定账号的原生 OAuth、API Key 或 Auth Token 直连上游。")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "示例:")
		_, _ = fmt.Fprintln(output, "  aih claude --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih claude --model-alias deepseek-flash # 本次会话任意模型经 Go Gateway 改写")
		_, _ = fmt.Fprintln(output, "  aih claude relay 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih claude 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "参数规则:")
		_, _ = fmt.Fprintln(output, "  AIH 模式/账号 token 必须放在前面；其后的参数原样交给官方 Claude CLI。")
		_, _ = fmt.Fprintln(output, "  查看官方 Claude CLI 参数请直接运行: claude --help")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "共享状态:")
		_, _ = fmt.Fprintln(output, "  所有模式继承同一个 CLAUDE_CONFIG_DIR；AIH 不创建账号级 HOME，会话、信任和插件配置保持共享。")
		_, _ = fmt.Fprintln(output, "  Native Direct 读取本地 AIH_HOME_DIR；Gateway Relay 仅读取本机 Server 连接配置，固定数字别名由目标 Server 解析。")
		return
	}

	if codebuddyfamilystorage.IsFamilyProvider(providerID) {
		_, _ = fmt.Fprintf(output, "AIH %s 用法:\n", providerID)
		_, _ = fmt.Fprintf(output, "  aih %s models [accountID|accountRef] [--json]  # 只读目标 Server 模型目录\n", providerID)
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" [原生参数...]                 # 自动择号启动（Native Direct）")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" <id> [原生参数...]              # 指定账号启动（伪 HOME 投影）")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" relay [原生参数...]              # AIH Server 网关档（models.json 注入）")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" relay [<provider>] <id> ...      # 网关档固定账号 / 跨 Provider")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" resume [<id>] [原生参数...]      # 续接（无 id = 最近一段）")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" sessions [<id>] [--all-projects]   # 列出受管持久会话")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" sessions --history [--limit N]   # 列出宿主会话历史")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" ls                              # 账号列表")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" usage [<id>] [--refresh]         # 额度（无 id = 全部账号）")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" home [<id>]                      # 投影路径诊断")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" version                         # 官方 CLI 版本")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" login                           # 原生 CLI 登录")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" detect                          # 扫描本机已登录账号")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" auto-switch on|off|status       # 全局自动换号")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" set-default <id> | unset-default")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" delete <id[,id...|start-end]...> | deleteall")
		_, _ = fmt.Fprintln(output, "  aih "+providerID+" terminal-icon [--install|--install-iterm2|--install-linux|--install-windows-terminal] [--all]")
		_, _ = fmt.Fprintln(output)
		_, _ = fmt.Fprintln(output, "说明:")
		_, _ = fmt.Fprintln(output, "  家族四支共用 codebuddy 二进制；账号边界由投影后的 HOME / CODEBUDDY_CONFIG_DIR 决定。")
		_, _ = fmt.Fprintln(output, "  裸 `aih "+providerID+"` 未指定账号时按健康度自动选一个账号（Native Direct）。")
		_, _ = fmt.Fprintln(output, "  `relay` 是独立的网关档：不注入任何 CodeBuddy 账号凭据，模型目录来自 AIH Server 的")
		_, _ = fmt.Fprintln(output, "  models.json 投影（<aiHome>/run/codebuddy-gateway），与账号档互不影响。")
		_, _ = fmt.Fprintln(output, "  会话/配置根通过共享链接回到宿主；fork 没有原生入口，aih 不猜参数。")
		return
	}

	_, _ = fmt.Fprintln(output, "AIH Codex 用法:")
	_, _ = fmt.Fprintf(output, "  aih %s models [accountID|accountRef] [--json]  # 只读目标 Server 模型目录\n", providerID)
	_, _ = fmt.Fprintln(output, "  aih codex [codex_args...]                            # Gateway 账号池")
	_, _ = fmt.Fprintln(output, "  aih codex relay <account_id> [codex_args...]         # Gateway 固定账号")
	_, _ = fmt.Fprintln(output, "  aih codex relay <provider> <account_id> [codex_args...] # Gateway 跨 Provider 固定账号")
	_, _ = fmt.Fprintln(output, "  aih codex <account_id> [codex_args...]               # Native Direct")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "模式说明:")
	_, _ = fmt.Fprintln(output, "  Gateway 账号池按请求中的真实模型公平征召 Codex 账号。")
	_, _ = fmt.Fprintln(output, "  Gateway 固定账号仍经 Server Relay，但不会失败换号。")
	_, _ = fmt.Fprintln(output, "  跨 Provider 固定账号让 Codex 客户端使用其他 Provider 的账号：Codex 仍发 Responses 请求，")
	_, _ = fmt.Fprintln(output, "  Server 用 Canonical Adapter 转码到目标 Provider 的线协议，模型必须是该账号可用的真实模型。")
	_, _ = fmt.Fprintln(output, "  Native Direct 使用指定账号的原生 OAuth 或 API Key 直连上游。")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "示例:")
	_, _ = fmt.Fprintln(output, "  aih codex --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex relay 1 --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex 1 --model gpt-5.5")
	_, _ = fmt.Fprintln(output, "  aih codex relay claude 9 --model claude-opus-5")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "参数规则:")
	_, _ = fmt.Fprintln(output, "  AIH 模式/账号 token 必须放在前面；其后的参数原样交给官方 Codex CLI。")
	_, _ = fmt.Fprintln(output, "  查看官方 Codex CLI 参数请直接运行: codex --help")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "共享状态:")
	_, _ = fmt.Fprintln(output, "  Gateway 模式继承同一个 CODEX_HOME；Native Direct 的 OAuth 账号使用账号级 CODEX_HOME，")
	_, _ = fmt.Fprintln(output, "  只有 auth.json/config.toml 私有，sessions、history、sqlite 和 harness 配置仍链接回宿主共享。")
	_, _ = fmt.Fprintln(output, "  API Key 账号与 Gateway 模式一样继承宿主 CODEX_HOME；AIH 不创建账号级 HOME。")
	_, _ = fmt.Fprintln(output, "  Native Direct 读取本地 AIH_HOME_DIR；Gateway Relay 不打开本地 AIH_HOME_DIR，固定数字别名由目标 Server 解析。")
}
