package providersessionhook

import (
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
	SenderExecPath string
	Platform       string
}

// BuildCommand 保留托管标记与 sender CLI 参数，供 JSON / agy Hook 安装器复用。
//
// 命令里**不写接收端 URL**：端口属于服务运行态，固化进第三方 provider 配置后
// 改端口/换机就失效，而且 Windows cmd 还要处理查询串转义。发送器在运行期按
// config:server 的当前监听地址解析接收端（见 sender.resolveReceiverURL），
// provider/event 由请求体携带，命令只需要稳定标识。
func BuildCommand(options CommandOptions) string {
	platform := commandPlatform(options.Platform)
	senderExec := resolveSenderExecutable(options.SenderExecPath, platform)
	quote := quotePOSIXToken
	if platform == "windows" {
		quote = quoteWindowsToken
	}
	return strings.Join([]string{
		quote(senderExec), "__provider-hook", Marker,
		"--provider", quote(options.Provider),
		"--event", quote(options.EventName),
	}, " ")
}

// SenderExecutable 返回托管 Hook 命令/插件应引用的发送器路径。
func SenderExecutable(explicit, platform string) string {
	return resolveSenderExecutable(explicit, commandPlatform(platform))
}

// ReferencesProvider 判断一条托管命令是否属于指定 provider。
//
// 只做文本事实判定（标记 + --provider 值），不看发送器形态：安装/诊断都要能
// 识别任何历史托管形状并把它们替换成当前形状，不需要继续支持旧参数。
func ReferencesProvider(command, provider string) bool {
	text := strings.TrimSpace(command)
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return true
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(text, "'--provider'", "--provider"), "\"--provider\"", "--provider")
	return strings.Contains(normalized, "--provider '"+provider+"'") ||
		strings.Contains(normalized, "--provider \""+provider+"\"") ||
		strings.Contains(normalized, "--provider "+provider)
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
