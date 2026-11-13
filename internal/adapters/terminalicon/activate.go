package terminalicon

import (
	"fmt"
	"io"
	"strings"
)

// PrepareForLaunch 在交互式启动前应用当前终端的图标策略：
//   - iTerm2：写入 Dynamic Profile 并发 SetProfile 序列；
//   - Warp：写 CLI-agent 命令映射（图标由 Warp 自己渲染）；
//   - Windows Terminal / 其它：发 OSC 0 标题徽标兜底。
//
// 返回终端类型与是否实际应用。非交互（无 TTY）调用方不要调用本函数。
func PrepareForLaunch(provider Provider, layout Layout, output io.Writer) (string, bool) {
	terminal := DetectTerminal(layout.Env)
	applied := false
	switch terminal {
	case "warp":
		if _, _, _, err := WriteWarpSettings([]Provider{provider}, layout); err == nil {
			applied = true
		}
		applied = writeTitle(output, provider) || applied
	case "iterm2":
		if _, _, err := WriteIterm2Profiles([]Provider{provider}, layout); err == nil {
			if _, err := io.WriteString(output, BuildSetProfileSequence(provider)); err == nil {
				applied = true
			}
		}
		applied = writeTitle(output, provider) || applied
	case "windows-terminal":
		if isWindowsTerminalActive(provider, layout.Env) {
			applied = true
		}
		applied = writeTitle(output, provider) || applied
	default:
		applied = writeTitle(output, provider)
	}
	return terminal, applied
}

// DetectTerminal 与 Node detectTerminalIconStrategy 的识别顺序一致（按平台）。
func DetectTerminal(env map[string]string) string {
	termProgram := strings.ToLower(strings.TrimSpace(env["TERM_PROGRAM"]))
	has := func(name string) bool { return strings.TrimSpace(env[name]) != "" }
	switch {
	case has("WT_SESSION") || has("WT_PROFILE_ID") || has("WtProfileId"):
		return "windows-terminal"
	case termProgram == "iterm.app" || has("ITERM_SESSION_ID"):
		return "iterm2"
	case has("KONSOLE_DBUS_SERVICE") || has("KONSOLE_DBUS_SESSION"):
		return "konsole"
	case termProgram == "warpterminal" || termProgram == "warp" ||
		has("WARP_IS_LOCAL_SHELL_SESSION") || has("WARP_SESSION_ID"):
		return "warp"
	case termProgram == "apple_terminal":
		return "apple-terminal"
	default:
		return "other"
	}
}

// BuildSetProfileSequence 是 iTerm2 的 SetProfile 控制序列。
func BuildSetProfileSequence(provider Provider) string {
	return "\x1b]1337;SetProfile=" + ProfileName(provider) + "\x07"
}

// BuildTitleSequence 是 OSC 0 标题序列；空标题返回空串。
func BuildTitleSequence(title string) string {
	clean := strings.TrimSpace(strings.NewReplacer(
		"\x00", " ", "\x01", " ", "\x02", " ", "\x03", " ", "\x04", " ", "\x05", " ",
		"\x06", " ", "\x07", " ", "\x08", " ", "\x09", " ", "\x0a", " ", "\x0b", " ",
		"\x0c", " ", "\x0d", " ", "\x0e", " ", "\x0f", " ", "\x10", " ", "\x11", " ",
		"\x12", " ", "\x13", " ", "\x14", " ", "\x15", " ", "\x16", " ", "\x17", " ",
		"\x18", " ", "\x19", " ", "\x1a", " ", "\x1b", " ", "\x1c", " ", "\x1d", " ",
		"\x1e", " ", "\x1f", " ", "\x7f", " ",
	).Replace(title))
	if clean == "" {
		return ""
	}
	return "\x1b]0;" + clean + "\x07"
}

// isWindowsTerminalActive 当前 tab 是否已经就是该 Provider 的 Profile。
func isWindowsTerminalActive(provider Provider, env map[string]string) bool {
	active := strings.ToLower(strings.TrimSpace(env["WT_PROFILE_ID"]))
	if active == "" {
		active = strings.ToLower(strings.TrimSpace(env["WtProfileId"]))
	}
	if active == "" {
		return false
	}
	want, err := StableGUID(provider)
	if err != nil {
		return false
	}
	return strings.EqualFold(normalizeGUID(active), normalizeGUID(want))
}

// writeTitle 发送标题徽标；失败或无标题时返回 false。
func writeTitle(output io.Writer, provider Provider) bool {
	sequence := BuildTitleSequence(Title(provider))
	if sequence == "" {
		return false
	}
	if _, err := io.WriteString(output, sequence); err != nil {
		return false
	}
	return true
}

// Describe 返回便于日志/测试的说明。
func Describe(terminal string, provider Provider) string {
	return fmt.Sprintf("%s:%s", terminal, provider.ID)
}
