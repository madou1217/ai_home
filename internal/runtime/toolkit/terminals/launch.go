package terminals

import (
	"os/exec"
	"strings"
)

// OpenRequest 描述打开本机客户端终端窗口的请求。
type OpenRequest struct {
	TerminalID string `json:"terminalId"`
	Title      string `json:"title"`
	Command    string `json:"command"`
	Transport  string `json:"transport"`
}

// OpenResult 是 POST /toolkit/terminals/open 的响应结构体。
type OpenResult struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Message    string `json:"message,omitempty"`
	Status     string `json:"status,omitempty"`
	TerminalID string `json:"terminalId,omitempty"`
	Executable string `json:"executable,omitempty"`
	PID        *int   `json:"pid,omitempty"`
}

// ResolveClientTerminalLaunch 解析指定客户端终端与命令对应的启动规格。
func ResolveClientTerminalLaunch(terminalID string, command string, title string, opts Options) *LaunchSpec {
	o := opts.withDefaults()
	normID := strings.ToLower(strings.TrimSpace(terminalID))
	if normID == "" {
		normID = DefaultTerminalID
	}
	plugin, ok := getTerminalPlugin(normID)
	if !ok || !supportsPlatform(plugin, o.clientPlatform()) || plugin.BuildLaunch == nil {
		return nil
	}
	return plugin.BuildLaunch(command, title, o)
}

// OpenClientTerminal 在本机拉起一个独立的客户端终端窗口。
// 当浏览器处于远端模式（transport == "webui"）时返回 web_terminal_required（409）。
func OpenClientTerminal(req OpenRequest, opts Options) OpenResult {
	o := opts.withDefaults()
	if strings.EqualFold(strings.TrimSpace(req.Transport), "webui") {
		return OpenResult{
			OK:      false,
			Error:   "web_terminal_required",
			Message: "当前浏览器不在 AIH Server 本机，终端会在 Web Terminal 中打开。",
		}
	}
	normID := strings.ToLower(strings.TrimSpace(req.TerminalID))
	if normID == "" {
		normID = DefaultTerminalID
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = DefaultTitle
	}
	command := strings.TrimSpace(req.Command)
	if command == "" {
		command = BuildInteractiveShellCommand(o)
	}
	spec := ResolveClientTerminalLaunch(normID, command, title, o)
	if spec == nil {
		return OpenResult{OK: false, Error: "terminal_not_available"}
	}
	if o.Launcher != nil {
		pid, err := o.Launcher(*spec)
		if err != nil {
			msg := strings.TrimSpace(err.Error())
			if msg == "" {
				msg = "terminal_launch_failed"
			}
			return OpenResult{OK: false, Error: msg}
		}
		var pidPtr *int
		if pid > 0 {
			p := pid
			pidPtr = &p
		}
		return OpenResult{
			OK:         true,
			Status:     "launched",
			TerminalID: firstNonEmpty(spec.TerminalID, normID),
			Executable: spec.File,
			PID:        pidPtr,
		}
	}

	cmd := exec.Command(spec.File, spec.Args...)
	applyPlatformLaunchAttrs(cmd, *spec)
	if err := cmd.Start(); err != nil {
		return OpenResult{OK: false, Error: err.Error()}
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	var pidPtr *int
	if pid > 0 {
		pidPtr = &pid
	}
	return OpenResult{
		OK:         true,
		Status:     "launched",
		TerminalID: firstNonEmpty(spec.TerminalID, normID),
		Executable: spec.File,
		PID:        pidPtr,
	}
}
