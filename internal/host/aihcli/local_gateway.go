package aihcli

// 本文件是「本地网关默认兜底」的唯一实现。
//
// 背景：Go CLI 只读环境变量（AIH_SERVER_BASE_URL / AIH_SERVER_API_KEY），而旧 Node
// 入口会从本地 config:server 自动补齐。Gateway Relay 模式（codex / claude）因此在裸
// 终端里报「Gateway Endpoint 无效」。这里把「从本地配置取回环网关默认值」收敛成一个
// 纯函数，由 CLI 各入口按需注入；Provider 启动只把它当**兜底**，不覆盖显式环境变量。

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ErrInvalidLocalGatewayConfig 表示本地 config:server 存在但不可用。
var ErrInvalidLocalGatewayConfig = errors.New("本地 Server 配置无效")

// LocalGatewayDefaults 是回环网关的兜底配置。
type LocalGatewayDefaults struct {
	// BaseURL 是回环根地址（不含 /v1）。
	BaseURL string
	// ClientKey 是本地客户端的 API Key（Gateway Relay 模式必需）。
	ClientKey string
	// ManagementKey 供管理类命令使用。
	ManagementKey string
}

// ReadLocalGatewayDefaults 从 aiHomeDir 的 config:server 读取回环网关默认值。
//
// 安全边界与既有 Claude 引导完全一致：显式地址不是回环、或回环但端口与本地配置
// 不一致时返回 ok=false —— 绝不把本机密钥发给远端地址。未显式指定地址时使用本地端口。
func ReadLocalGatewayDefaults(
	ctx context.Context,
	aiHomeDir string,
	explicitBaseURL string,
) (LocalGatewayDefaults, bool, error) {
	if ctx == nil || strings.TrimSpace(aiHomeDir) == "" {
		return LocalGatewayDefaults{}, false, nil
	}
	explicit := strings.TrimSpace(explicitBaseURL)
	var endpoint *url.URL
	if explicit != "" {
		parsed, err := url.Parse(explicit)
		if err != nil ||
			(parsed.Scheme != "http" && parsed.Scheme != "https") ||
			parsed.Host == "" ||
			parsed.User != nil ||
			parsed.RawQuery != "" ||
			parsed.Fragment != "" ||
			(parsed.Path != "" && parsed.Path != "/") {
			// 显式地址本身非法：交给上层校验报错，不参与兜底。
			return LocalGatewayDefaults{}, false, nil
		}
		if !isLoopbackHost(parsed.Hostname()) {
			return LocalGatewayDefaults{}, false, nil
		}
		if parsed.Scheme != "http" {
			// 本地 Server 只监听明文回环；https 显式地址视为远端语义。
			return LocalGatewayDefaults{}, false, nil
		}
		endpoint = parsed
	}

	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return LocalGatewayDefaults{}, false, nil
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, appstate.KeyServerConfig)
	if err != nil || !found {
		return LocalGatewayDefaults{}, false, nil
	}
	var config struct {
		Port          int    `json:"port"`
		APIKey        string `json:"apiKey"`
		ManagementKey string `json:"managementKey"`
	}
	if jsonErr := json.Unmarshal([]byte(raw), &config); jsonErr != nil {
		if endpoint != nil {
			return LocalGatewayDefaults{}, false, nil
		}
		return LocalGatewayDefaults{}, false, ErrInvalidLocalGatewayConfig
	}
	if config.Port == 0 {
		config.Port = serverconfig.DefaultPort
	}
	if !serverconfig.IsValidPort(config.Port) {
		if endpoint != nil {
			return LocalGatewayDefaults{}, false, nil
		}
		return LocalGatewayDefaults{}, false, ErrInvalidLocalGatewayConfig
	}
	base := "http://127.0.0.1:" + strconv.Itoa(config.Port)
	if endpoint != nil {
		port := endpoint.Port()
		if port == "" {
			port = "80"
		}
		if port != strconv.Itoa(config.Port) {
			// 回环但端口不同：那是另一台/另一个实例，不能借用本机密钥。
			return LocalGatewayDefaults{}, false, nil
		}
		base = explicit
	}
	if strings.TrimSpace(config.APIKey) == "" {
		return LocalGatewayDefaults{}, false, nil
	}
	return LocalGatewayDefaults{
		BaseURL:       base,
		ClientKey:     strings.TrimSpace(config.APIKey),
		ManagementKey: strings.TrimSpace(config.ManagementKey),
	}, true, nil
}

// isLoopbackHost 判断主机名是否为本机回环。
func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
