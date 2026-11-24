package codexenvironments

import (
	"fmt"
	"path"
	"strconv"
	"strings"
)

// 拒绝原因码；稳定且可直接透出给用户。
const (
	CodeUnsupported = "codex_environment_unsupported_auth"
	CodeInvalid     = "codex_environment_invalid_connection"
)

// 远端 exec-server 的固定启动方式：在远端用户的登录 shell 里起 stdio 执行服务。
var remoteExecServerArgv = []string{"codex", "exec-server", "--listen", "stdio"}

// defaultInitializeTimeoutSec 给远端首次启动留出余量（远端要拉起 codex 进程树）。
const defaultInitializeTimeoutSec = 30

// BuildEntry 把一条连接渲染成 Codex 执行环境；不受支持时返回 Rejection。
//
// 所有连接都走 program=ssh 这一条原语：由 Codex 自己拉起 ssh，AIH 只需给出
// 与它自己拨号时一致的显式参数。password 认证不在这里处理——它需要 askpass
// 与临时凭据文件的生命周期管理，必须由调用方在建连时注入，因此明确拒绝而不是
// 静默退化成无认证。
func BuildEntry(connection Connection) (Entry, *Rejection) {
	if reason := validateConnection(connection); reason != nil {
		return Entry{}, reason
	}
	args := buildSSHArgs(connection)
	entry := Entry{
		ID:                   EnvironmentID(connection.ID),
		Program:              "ssh",
		Args:                 args,
		InitializeTimeoutSec: defaultInitializeTimeoutSec,
	}
	return entry, nil
}

// EnvironmentID 是 AIH 条目在 Codex 侧的稳定标识：重复生成必须幂等。
func EnvironmentID(connectionID string) string {
	return "aih-" + strings.TrimSpace(connectionID)
}

func validateConnection(connection Connection) *Rejection {
	id := strings.TrimSpace(connection.ID)
	if id == "" {
		return &Rejection{Code: CodeInvalid, Message: "SSH 连接缺少 ID"}
	}
	label := strings.TrimSpace(connection.Label)
	reject := func(code, message string) *Rejection {
		return &Rejection{ConnectionID: id, Label: label, Code: code, Message: message}
	}
	if strings.TrimSpace(connection.Host) == "" {
		return reject(CodeInvalid, "SSH 连接缺少主机地址")
	}
	if strings.ContainsAny(connection.Host, " \t\r\n\x00") {
		return reject(CodeInvalid, "SSH 主机不能包含空白或控制字符")
	}
	switch normalizeAuth(connection.AuthType) {
	case AuthAgent, AuthKeyFile:
		return nil
	case AuthPassword:
		return reject(CodeUnsupported, "密码认证需要临时 askpass 凭据，Codex 无法直接复用，请在 AIH 里改用密钥认证")
	default:
		return reject(CodeUnsupported, "不支持的认证方式："+strings.TrimSpace(connection.AuthType))
	}
}

func normalizeAuth(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", AuthAgent:
		return AuthAgent
	case AuthKey, AuthKeyFile:
		return AuthKeyFile
	case AuthPassword:
		return AuthPassword
	default:
		return strings.ToLower(strings.TrimSpace(raw))
	}
}

func connectionPort(connection Connection) int {
	if connection.Port > 0 && connection.Port <= 65535 {
		return connection.Port
	}
	return 22
}

// buildSSHArgs 产出 argv，形状与 AIH 自己拨号时保持一致：
// BatchMode 禁止交互提示，ConnectTimeout 与 sshhost 的探测口径对齐；
// 端口用 -p 传递（不要把端口拼进目标串，否则 -p 会重复生效）。
func buildSSHArgs(connection Connection) []string {
	args := []string{"-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12"}
	if port := connectionPort(connection); port != 22 {
		args = append(args, "-p", strconv.Itoa(port))
	}
	if identity := strings.TrimSpace(connection.IdentityFile); identity != "" {
		args = append(args, "-i", expandHome(identity), "-o", "IdentitiesOnly=yes")
	}
	if jump := connection.Jump; jump != nil {
		jumpArgs := buildSSHArgs(*jump)
		args = append(args, "-o", "ProxyJump="+strings.Join(jumpArgs[:len(jumpArgs)-len(remoteExecServerArgv)], " "))
	}
	args = append(args, sshTarget(connection))
	return append(args, remoteExecServerArgv...)
}

// sshTarget 产出 user@host。用户名必须带上：AIH 连接里的 user 是权威事实，
// 而目标主机的 ~/.ssh/config 里未必有对应别名，缺了它会退化成"当前用户"。
func sshTarget(connection Connection) string {
	host := strings.TrimSpace(connection.Host)
	if user := strings.TrimSpace(connection.User); user != "" {
		return user + "@" + host
	}
	return host
}

// expandHome 让 ~/x 在 ssh 子进程里可用；这里只做路径归一，不访问文件系统。
func expandHome(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "~" {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, `~\`) {
		return "~/" + path.Clean(strings.TrimPrefix(strings.TrimPrefix(trimmed, "~/"), `~\`))
	}
	return trimmed
}

// FormatPort 供诊断输出使用。
func FormatPort(connection Connection) string {
	return fmt.Sprintf("%s:%d", strings.TrimSpace(connection.Host), connectionPort(connection))
}
