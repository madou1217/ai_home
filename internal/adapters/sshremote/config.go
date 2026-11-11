package sshremote

import (
	"os"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

// 认证方式标识；与 Node 的 authType 取值保持一致。
const (
	AuthAgent    = "agent"
	AuthKey      = "key"
	AuthKeyFile  = sshhost.KeyFileAuthType
	AuthPassword = "password"

	// DefaultPort 是 ssh 的默认端口。
	DefaultPort = 22
)

// Config 是一条 SSH 连接在拨号时需要的全部事实。
//
// 字段名与 app_kv: ssh_connections 的记录对齐，由调用方展开后传入；
// 本包不读数据库，也不缓存凭据。
type Config struct {
	Host         string
	Port         int
	User         string
	AuthType     string
	Password     string
	PrivateKey   string
	IdentityFile string
	// KnownHostsPath 为空时用 <home>/.ssh/known_hosts；文件不存在按 accept-new 创建。
	KnownHostsPath string
	// HomeDir 用于 ~ 展开与默认 known_hosts 位置；为空时取当前用户家目录。
	HomeDir string
	// HostKeyCallback 仅供测试注入；非空时完全不读 known_hosts。
	HostKeyCallback ssh.HostKeyCallback
}

// Validate 校验拨号必需的字段；消息直接面向 WebUI 用户。
func (config Config) Validate() error {
	if strings.TrimSpace(config.Host) == "" {
		return newError(CodeInvalidConfig, "SSH 主机不能为空", nil)
	}
	if strings.ContainsAny(config.Host, " \t\r\n\x00") {
		return newError(CodeInvalidConfig, "SSH 主机不能包含空白或控制字符", nil)
	}
	if config.Port < 0 || config.Port > 65535 {
		return newError(CodeInvalidConfig, "SSH 端口必须在 1-65535 之间", nil)
	}
	switch config.authType() {
	case AuthAgent, AuthKeyFile:
		return nil
	case AuthKey:
		if strings.TrimSpace(config.PrivateKey) == "" {
			return newError(CodeInvalidConfig, "SSH 私钥认证缺少私钥内容", nil)
		}
	case AuthPassword:
		if config.Password == "" {
			return newError(CodeInvalidConfig, "SSH 密码认证缺少密码", nil)
		}
	default:
		return newError(CodeInvalidConfig, "不支持的 SSH 认证方式: "+config.authType(), nil)
	}
	return nil
}

// authType 归一认证方式；空值沿用 Node 的默认值 agent。
func (config Config) authType() string {
	value := strings.TrimSpace(config.AuthType)
	if value == "" {
		return AuthAgent
	}
	return value
}

// port 返回实际连接端口。
func (config Config) port() int {
	if config.Port == 0 {
		return DefaultPort
	}
	return config.Port
}

// address 返回 host:port 形式的目标地址。
func (config Config) address() string {
	return strings.TrimSpace(config.Host) + ":" + strconv.Itoa(config.port())
}

// userName 返回登录用户名；空值回落到当前系统用户，与系统 ssh 的行为一致。
func (config Config) userName() (string, error) {
	if user := strings.TrimSpace(config.User); user != "" {
		return user, nil
	}
	for _, name := range []string{"USER", "USERNAME"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value, nil
		}
	}
	return "", newError(CodeInvalidConfig, "SSH 用户名不能为空", nil)
}

// homeDir 返回用于 ~ 展开与 known_hosts 默认位置的家目录。
func (config Config) homeDir() (string, error) {
	if home := strings.TrimSpace(config.HomeDir); home != "" {
		return home, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", newError(CodeInvalidConfig, "无法确定当前用户家目录", err)
	}
	return home, nil
}
