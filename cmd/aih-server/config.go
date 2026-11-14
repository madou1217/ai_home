package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihserver"
)

const (
	defaultServerHost                  = "127.0.0.1"
	defaultServerPort                  = 9527
	defaultCodexHookSelfHealIntervalMs = 15000
)

var (
	// errInvalidCommandConfig 表示 CLI 参数或环境配置不符合当前 Go Server 合同。
	errInvalidCommandConfig = errors.New("aih-server 配置无效")
	// errNonLoopbackHost 表示当前里程碑拒绝直接暴露明文远程管理接口。
	errNonLoopbackHost = errors.New("当前 Go Server 只允许监听 loopback 地址")
)

// commandConfig 是不会被日志格式化的 Go Server 启动配置。
type commandConfig struct {
	host          string
	port          int
	aiHomeDir     string
	managementKey string
	clientKey     string
	// delegateCredentialRefresh 由 AIH_SERVER_CREDENTIAL_REFRESH=delegated 打开：
	// Node 宿主监督 Go 时独占 OAuth 刷新，避免两个刷新者竞争会轮换的 Refresh Token。
	delegateCredentialRefresh bool
	// upstreamErrorRuleProviders 由 AIH_SERVER_UPSTREAM_ERROR_RULES 声明（逗号分隔）。
	// 缺省为空：Go 不承接任何账号的自定义错误规则，Node 继续自己执行规则。
	upstreamErrorRuleProviders []string
	// webDir 是 Web UI 构建产物目录；为空表示不由 Go 托管 /ui（过渡期 Node 仍在服务）。
	webDir string
	// nodeBaseURL 是 Node 宿主的回环管理地址（监督器注入）。为空时不挂实例启停路由。
	nodeBaseURL string
	// frontDoor 表示本进程拥有公开端口：未注册的路径转交给 nodeBaseURL。
	// 关闭时（缺省）Go 仍只跑私有端口，未注册路径保持 404。
	frontDoor bool
	// nodeExecPath 与 entryFilePath 由监督器通过 AIH_SERVER_NODE_EXEC / AIH_SERVER_ENTRY_FILE 注入，
	// 供原生重启接口拉起独立后台重启进程；允许缺省，但显式设置损坏值时在启动期拦截。
	nodeExecPath  string
	entryFilePath string
	// codexHooks 配置由 Go Server 承载的 Codex CLI/Desktop/VSCode Hook 守护参数。
	codexHooks codexHooksConfig
}

type codexHooksConfig struct {
	enableCLIHook                bool
	enableDesktopHook            bool
	cliSelfHealIntervalMs        int
	desktopSelfHealIntervalMs    int
	providerHookReceiverURL      string
	traceFile                    string
	traceResponses               bool
	traceRemoteControl           bool
	remoteControlProxy           bool
	restartAppServerOnHookChange bool
}

// frontDoorBaseURL 只在公开端口模式下返回 Node 私有地址；其余情况为空，
// 让 Go 保持「私有端口 + 未注册路径 404」的既有合同。
func (config commandConfig) frontDoorBaseURL() string {
	if !config.frontDoor {
		return ""
	}
	return config.nodeBaseURL
}

// listenAddress 返回 IPv4、IPv6 都可安全使用的监听地址。
func (config commandConfig) listenAddress() string {
	return net.JoinHostPort(config.host, strconv.Itoa(config.port))
}

// loadCommandConfig 从正式环境变量和显式 CLI 参数构建启动配置。
func loadCommandConfig(
	args []string,
	runtime commandRuntime,
) (commandConfig, error) {
	host := envValue(runtime.lookupEnv, "AIH_SERVER_HOST", defaultServerHost)
	port, err := envPort(runtime.lookupEnv)
	if err != nil {
		return commandConfig{}, err
	}

	flags := flag.NewFlagSet("aih-server", flag.ContinueOnError)
	flags.SetOutput(runtime.stderr)
	flags.StringVar(&host, "host", host, "监听地址；当前只允许 loopback")
	flags.IntVar(&port, "port", port, "监听端口；0 表示由系统分配临时端口")
	var webDir string
	flags.StringVar(&webDir, "web-dir", "", "Web UI 构建产物目录（web/dist）；为空时不托管 /ui")
	var nodeBaseURL string
	flags.StringVar(&nodeBaseURL, "node-base-url", "", "Node 宿主回环地址；由 Go Core 监督器注入，不面向用户")
	var frontDoor bool
	flags.BoolVar(&frontDoor, "front-door", false, "本进程拥有公开端口：未注册的路由转交给 --node-base-url")
	hooksCfg := codexHooksConfig{
		cliSelfHealIntervalMs:     defaultCodexHookSelfHealIntervalMs,
		desktopSelfHealIntervalMs: defaultCodexHookSelfHealIntervalMs,
		traceRemoteControl:        true,
		remoteControlProxy:        true,
	}
	flags.BoolVar(&hooksCfg.enableCLIHook, "enable-codex-cli-hook", false, "启用 Codex CLI Hook 注入与后台自愈")
	flags.BoolVar(&hooksCfg.enableDesktopHook, "enable-codex-desktop-hook", false, "启用 Codex Desktop/VSCode Hook 注入与后台自愈")
	flags.IntVar(&hooksCfg.cliSelfHealIntervalMs, "codex-cli-hook-self-heal-interval-ms", defaultCodexHookSelfHealIntervalMs, "Codex CLI Hook 后台自愈间隔（毫秒）")
	flags.IntVar(&hooksCfg.desktopSelfHealIntervalMs, "codex-desktop-hook-self-heal-interval-ms", defaultCodexHookSelfHealIntervalMs, "Codex Desktop/VSCode Hook 后台自愈间隔（毫秒）")
	flags.StringVar(&hooksCfg.providerHookReceiverURL, "codex-provider-hook-receiver-url", "", "覆盖 Codex Desktop provider hook 回调地址；留空按 node-base-url 派生")
	flags.StringVar(&hooksCfg.traceFile, "codex-desktop-trace-file", "", "Codex Desktop 代理追踪日志文件路径")
	flags.BoolVar(&hooksCfg.traceResponses, "codex-desktop-trace-responses", false, "开启 Codex Desktop responses 追踪日志")
	flags.BoolVar(&hooksCfg.traceRemoteControl, "codex-desktop-trace-remote-control", true, "开启 Codex Desktop remote-control 追踪")
	flags.BoolVar(&hooksCfg.remoteControlProxy, "codex-desktop-remote-control-proxy", true, "开启 Codex Desktop remote-control 代理开关")
	flags.BoolVar(&hooksCfg.restartAppServerOnHookChange, "codex-desktop-restart-app-server-on-hook-change", false, "trace 或 helper 变更时自动重启运行中的 desktop app-server")
	flags.Usage = func() {
		writeUsage(runtime.stderr, flags)
	}
	if err := flags.Parse(args); err != nil {
		return commandConfig{}, err
	}
	if flags.NArg() != 0 {
		return commandConfig{}, errInvalidCommandConfig
	}
	host = strings.TrimSpace(host)
	if !isLoopbackHost(host) {
		return commandConfig{}, errNonLoopbackHost
	}
	if port < 0 || port > 65535 {
		return commandConfig{}, errInvalidCommandConfig
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return commandConfig{}, err
	}
	// 环境变量是运维的临时覆盖；持久化配置才是权威来源。Go 必须在没有 Node
	// 监督者注入环境变量时也能独立启动，因此缺项从 app-state 的 config:server 补齐。
	managementKey := strings.TrimSpace(envValue(runtime.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY", ""))
	clientKey := strings.TrimSpace(envValue(runtime.lookupEnv, "AIH_SERVER_API_KEY", ""))
	if managementKey == "" || clientKey == "" {
		storedManagementKey, storedClientKey := readPersistedServerKeys(aiHomeDir)
		if managementKey == "" {
			managementKey = storedManagementKey
		}
		if clientKey == "" {
			clientKey = storedClientKey
		}
	}
	if err := aihserver.ValidateServerKeys(managementKey, clientKey); err != nil {
		return commandConfig{}, err
	}
	delegate, err := envCredentialRefreshDelegated(runtime.lookupEnv)
	if err != nil {
		return commandConfig{}, err
	}
	ruleProviders, err := envUpstreamErrorRuleProviders(runtime.lookupEnv)
	if err != nil {
		return commandConfig{}, err
	}
	nodeBaseURL = strings.TrimSpace(nodeBaseURL)
	if nodeBaseURL != "" && !isLoopbackBaseURL(nodeBaseURL) {
		return commandConfig{}, errInvalidCommandConfig
	}
	if frontDoor {
		// 前置门必须有回退目标，且不能指向自己：指向自身会让未注册路径无限自环，
		// 表现为 CPU 打满而不是一个可定位的错误。
		if nodeBaseURL == "" {
			return commandConfig{}, errInvalidCommandConfig
		}
		nodePort, portErr := loopbackURLPort(nodeBaseURL)
		if portErr != nil || nodePort == port {
			return commandConfig{}, errInvalidCommandConfig
		}
	}
	if hooksCfg.cliSelfHealIntervalMs <= 0 || hooksCfg.desktopSelfHealIntervalMs <= 0 {
		return commandConfig{}, errInvalidCommandConfig
	}
	if strings.IndexFunc(hooksCfg.traceFile, unicode.IsControl) >= 0 {
		return commandConfig{}, errInvalidCommandConfig
	}
	hooksCfg.traceFile = strings.TrimSpace(hooksCfg.traceFile)
	if strings.IndexFunc(hooksCfg.providerHookReceiverURL, unicode.IsControl) >= 0 {
		return commandConfig{}, errInvalidCommandConfig
	}
	hooksCfg.providerHookReceiverURL = strings.TrimSpace(hooksCfg.providerHookReceiverURL)
	if hooksCfg.providerHookReceiverURL != "" && !isLoopbackBaseURL(hooksCfg.providerHookReceiverURL) {
		return commandConfig{}, errInvalidCommandConfig
	}
	nodeExecPath, err := envOptionalPath(runtime.lookupEnv, "AIH_SERVER_NODE_EXEC")
	if err != nil {
		return commandConfig{}, err
	}
	entryFilePath, err := envOptionalPath(runtime.lookupEnv, "AIH_SERVER_ENTRY_FILE")
	if err != nil {
		return commandConfig{}, err
	}
	return commandConfig{
		host:                       host,
		port:                       port,
		aiHomeDir:                  aiHomeDir,
		managementKey:              managementKey,
		clientKey:                  clientKey,
		delegateCredentialRefresh:  delegate,
		upstreamErrorRuleProviders: ruleProviders,
		webDir:                     strings.TrimSpace(webDir),
		nodeBaseURL:                nodeBaseURL,
		frontDoor:                  frontDoor,
		nodeExecPath:               nodeExecPath,
		entryFilePath:              entryFilePath,
		codexHooks:                 hooksCfg,
	}, nil
}

// envOptionalPath 校验可选路径环境变量：未设置或空串按缺省处理，
// 显式设置为纯空白或包含控制字符时拒绝启动。
func envOptionalPath(lookupEnv func(string) (string, bool), name string) (string, error) {
	raw, found := lookupEnv(name)
	if !found || raw == "" {
		return "", nil
	}
	if strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return "", errInvalidCommandConfig
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errInvalidCommandConfig
	}
	return trimmed, nil
}

// isLoopbackBaseURL 只接受 http + loopback 的 Node 地址：管理密钥不能发到远端。
func isLoopbackBaseURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return false
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// envUpstreamErrorRuleProviders 严格解析已接入规则求值的 Provider 列表。
//
// 缺省为空表示能力关闭（Go 不承接任何账号的规则）；出现空项或重复项即报错，
// 而不是静默忽略——能力声明写错会让 Go 悄悄接管或悄悄放弃一批账号。
func envUpstreamErrorRuleProviders(lookupEnv func(string) (string, bool)) ([]string, error) {
	raw, found := lookupEnv("AIH_SERVER_UPSTREAM_ERROR_RULES")
	if !found || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	providers := []string{}
	seen := map[string]struct{}{}
	for _, item := range strings.Split(raw, ",") {
		provider := strings.ToLower(strings.TrimSpace(item))
		if provider == "" {
			return nil, errInvalidCommandConfig
		}
		if _, duplicate := seen[provider]; duplicate {
			return nil, errInvalidCommandConfig
		}
		seen[provider] = struct{}{}
		providers = append(providers, provider)
	}
	return providers, nil
}

// envCredentialRefreshDelegated 严格解析刷新所有权：缺省/self 自行刷新，delegated 交给宿主。
func envCredentialRefreshDelegated(lookupEnv func(string) (string, bool)) (bool, error) {
	switch envValue(lookupEnv, "AIH_SERVER_CREDENTIAL_REFRESH", "") {
	case "", "self":
		return false, nil
	case "delegated":
		return true, nil
	default:
		return false, errInvalidCommandConfig
	}
}

// envPort 严格解析环境端口，不把错误值静默回退到默认端口。
func envPort(lookupEnv func(string) (string, bool)) (int, error) {
	raw, found := lookupEnv("AIH_SERVER_PORT")
	if !found || raw == "" {
		return defaultServerPort, nil
	}
	if strings.TrimSpace(raw) != raw {
		return 0, errInvalidCommandConfig
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 0 || port > 65535 {
		return 0, errInvalidCommandConfig
	}
	return port, nil
}

// readPersistedServerKeys 从 app-state.db 的 config:server 读取权威密钥。
//
// 读取失败按「没有持久化配置」处理：启动继续走环境变量（与旧行为一致），
// 最终由 ValidateServerKeys 对结果失败关闭。这样 Go 不依赖 Node 监督者
// 注入 AIH_SERVER_* 就能独立启动，同时保留环境变量作为运维覆盖。
func readPersistedServerKeys(aiHomeDir string) (managementKey, clientKey string) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return "", ""
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, "config:server")
	if err != nil || !found {
		return "", ""
	}
	var stored struct {
		ManagementKey string `json:"managementKey"`
		APIKey        string `json:"apiKey"`
	}
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return "", ""
	}
	return strings.TrimSpace(stored.ManagementKey), strings.TrimSpace(stored.APIKey)
}

// resolveAIHomeDir 只读取规范 AIH_HOME_DIR，缺省时使用当前用户的 .ai_home。
// 刻意不接受 AIH_HOME / AI_HOME 等旧别名：Go Core 只认一个名字，避免两侧数据根分家。
func resolveAIHomeDir(runtime commandRuntime) (string, error) {
	value := strings.TrimSpace(envValue(runtime.lookupEnv, "AIH_HOME_DIR", ""))
	if value == "" {
		userHome, err := runtime.userHomeDir()
		if err != nil || strings.TrimSpace(userHome) == "" {
			return "", errInvalidCommandConfig
		}
		value = filepath.Join(userHome, ".ai_home")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", errInvalidCommandConfig
	}
	return absolute, nil
}

// isLoopbackHost 拒绝 wildcard、LAN 和无法在本地确定的主机名。
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// envValue 返回去除首尾空白的环境变量或默认值。
func envValue(
	lookupEnv func(string) (string, bool),
	name string,
	fallback string,
) string {
	value, found := lookupEnv(name)
	if !found {
		return fallback
	}
	return strings.TrimSpace(value)
}

// writeUsage 输出不包含 Management Key 值的启动帮助。
func writeUsage(output io.Writer, flags *flag.FlagSet) {
	_, _ = fmt.Fprintln(output, "用法: aih-server [--host HOST] [--port PORT]")
	_, _ = fmt.Fprintln(output)
	flags.PrintDefaults()
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "环境变量:")
	_, _ = fmt.Fprintln(output, "  AIH_HOME_DIR")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_HOST")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_PORT")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_API_KEY（必填，不接受命令行传入）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填，不接受命令行传入）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_CREDENTIAL_REFRESH（self|delegated，默认 self）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_NODE_EXEC（可选，Server 重启拉起 Node 进程的可执行路径）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_ENTRY_FILE（可选，Server 重启调用的入口脚本路径）")
}
