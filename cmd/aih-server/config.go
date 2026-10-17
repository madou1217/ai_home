package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/host/aihserver"
)

const (
	defaultServerHost = "127.0.0.1"
	defaultServerPort = 9527
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
	managementKey, _ := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	clientKey, _ := runtime.lookupEnv("AIH_SERVER_CLIENT_KEY")
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
	return commandConfig{
		host:                       host,
		port:                       port,
		aiHomeDir:                  aiHomeDir,
		managementKey:              managementKey,
		clientKey:                  clientKey,
		delegateCredentialRefresh:  delegate,
		upstreamErrorRuleProviders: ruleProviders,
	}, nil
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
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_CLIENT_KEY（必填，不接受命令行传入）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_MANAGEMENT_KEY（必填，不接受命令行传入）")
	_, _ = fmt.Fprintln(output, "  AIH_SERVER_CREDENTIAL_REFRESH（self|delegated，默认 self）")
}
