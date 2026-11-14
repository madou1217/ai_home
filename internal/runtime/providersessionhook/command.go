package providersessionhook

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// CommandOptions 是两个 Hook 安装入口共用的原生发送器命令参数。
// SenderExecPath 由宿主显式覆盖；默认只复用真正的 aih-server，其他调用方
// 查找同目录或 PATH 上的 server。不解析可能指向 Node 包装器的 AIH_EXECUTABLE。
type CommandOptions struct {
	Provider       string
	EventName      string
	ReceiverURL    string
	SenderExecPath string
	Platform       string
}

// BuildCommand 保留托管标记与 sender CLI 参数，供 JSON / agy Hook 安装器复用。
// Native 与 Gateway 会话使用同一命令：账号与 correlation 仍由发送时的环境读取，
// 安装时不固化账号、网关凭据或运行模式。
func BuildCommand(options CommandOptions) string {
	platform := commandPlatform(options.Platform)
	windows := platform == "windows"
	senderExec := resolveSenderExecutable(options.SenderExecPath, platform)

	receiver := strings.TrimSpace(options.ReceiverURL)
	if receiver == "" {
		receiver = DefaultReceiverURL
	}
	quote := quotePOSIXToken
	if windows {
		// Windows 官方 CLI 经 cmd 执行 Hook。查询串的 & 会被解释为命令分隔符，
		// 延续原有协议剥离查询串，provider/event 由 sender 写入请求体。
		if index := strings.IndexByte(receiver, '?'); index >= 0 {
			receiver = receiver[:index]
		}
		quote = quoteWindowsToken
	} else {
		separator := "?"
		if strings.Contains(receiver, "?") {
			separator = "&"
		}
		parts := make([]string, 0, 2)
		if strings.TrimSpace(options.Provider) != "" {
			parts = append(parts, "provider="+url.QueryEscape(options.Provider))
		}
		if strings.TrimSpace(options.EventName) != "" {
			parts = append(parts, "event="+url.QueryEscape(options.EventName))
		}
		if len(parts) > 0 {
			receiver += separator + strings.Join(parts, "&")
		}
	}
	return strings.Join([]string{
		quote(senderExec), "__provider-hook", Marker,
		"--provider", quote(options.Provider),
		"--event", quote(options.EventName),
		"--url", quote(receiver),
	}, " ")
}

func commandPlatform(value string) string {
	switch platform := strings.ToLower(strings.TrimSpace(value)); platform {
	case "":
		return runtime.GOOS
	case "win", "win32", "windows":
		return "windows"
	case "mac", "macos", "darwin":
		return "darwin"
	default:
		return platform
	}
}

// resolveSenderExecutable 不假设 toolkit Manager 一定嵌在 aih-server 中。
// Go CLI / 其他宿主不能因 os.Executable 成功就被写成不支持该子命令的 sender。
func resolveSenderExecutable(explicit, platform string) string {
	if value := strings.TrimSpace(explicit); value != "" {
		return value
	}
	name := "aih-server"
	if platform == "windows" {
		name += ".exe"
	}
	// 跨平台生成时不能把本机可执行文件路径写进目标平台的配置。
	if platform != runtime.GOOS {
		return name
	}
	if current, err := os.Executable(); err == nil && strings.TrimSpace(current) != "" {
		base := filepath.Base(current)
		if base == name || (platform == "windows" && strings.EqualFold(base, name)) {
			return current
		}
		sibling := filepath.Join(filepath.Dir(current), name)
		if info, err := os.Stat(sibling); err == nil && info.Mode().IsRegular() &&
			(platform == "windows" || info.Mode().Perm()&0o111 != 0) {
			return sibling
		}
	}
	if found, err := exec.LookPath(name); err == nil {
		return found
	}
	// 未安装时仍明确要求 server；不静默回落到当前 CLI、Node 或源码脚本。
	return name
}

func quotePOSIXToken(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// 无空格或 cmd 元字符时维持裸 token，兼容官方 CLI 的多层命令串转义；
// 有空格/元字符的 executable 必须整体引用，不能退回另一个 PATH 上的二进制。
func quoteWindowsToken(value string) string {
	text := strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	if text != "" && !strings.ContainsAny(text, " \t\r\n\"&|<>^()") {
		return text
	}
	return "\"" + strings.ReplaceAll(text, "\"", "\"\"") + "\""
}
