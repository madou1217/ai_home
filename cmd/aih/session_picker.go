package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// pickerAction 是选择器按键解析后的动作。
type pickerAction int

const (
	pickerNone pickerAction = iota
	pickerQuit
	pickerAttach
	pickerCopyID
	pickerCopyCommand
	pickerClose
	pickerCloseIdle
)

// pickerState 是选择器的纯状态：选中项、详情开关与提示行。
// 交互循环只负责读键、恢复终端与执行动作，渲染/移动都可以单测。
type pickerState struct {
	rows     []persistent.SessionRow
	selected int
	detail   bool
	toast    string
}

func newPickerState(rows []persistent.SessionRow) *pickerState {
	return &pickerState{rows: rows}
}

func (state *pickerState) move(delta int) {
	if len(state.rows) == 0 {
		state.selected = 0
		return
	}
	next := state.selected + delta
	if next < 0 {
		next = 0
	}
	if next >= len(state.rows) {
		next = len(state.rows) - 1
	}
	state.selected = next
}

func (state *pickerState) current() *persistent.SessionRow {
	if state.selected < 0 || state.selected >= len(state.rows) {
		return nil
	}
	return &state.rows[state.selected]
}

// handleKey 把一次按键映射成动作；未知按键返回 pickerNone。
func (state *pickerState) handleKey(key string) pickerAction {
	switch key {
	case "up", "k":
		state.move(-1)
		return pickerNone
	case "down", "j":
		state.move(1)
		return pickerNone
	case "enter":
		if state.current() != nil {
			return pickerAttach
		}
		return pickerNone
	case "d":
		state.detail = !state.detail
		return pickerNone
	case "c":
		return pickerCopyID
	case "y":
		return pickerCopyCommand
	case "x":
		if state.current() != nil {
			return pickerClose
		}
		return pickerNone
	case "X":
		return pickerCloseIdle
	case "q", "esc", "ctrl-c":
		return pickerQuit
	default:
		return pickerNone
	}
}

// pickerCopyText 返回 c/y 要复制的文本：优先原生会话 id，其次 tmux 名。
func pickerCopyText(row persistent.SessionRow) string {
	if native := strings.TrimSpace(row.NativeID); native != "" {
		return native
	}
	return strings.TrimSpace(row.Name)
}

// pickerResumeCommand 返回 y 复制的续接命令。
func pickerResumeCommand(row persistent.SessionRow) string {
	identity := pickerCopyText(row)
	if identity == "" {
		return ""
	}
	return "aih " + row.Provider + " resume " + identity
}

// renderPicker 输出整屏（调用方负责清屏与光标位置）。
func renderPicker(
	output io.Writer,
	state *pickerState,
	labels map[string]string,
) {
	_, _ = fmt.Fprintf(output, "[aih] 活跃持久会话（%d）  ↑/↓ 选择 · Enter 进入 · d 详情 · c 复制ID · y 复制命令 · x 关闭 · X 关闲置 · q 退出\r\n", len(state.rows))
	if len(state.rows) == 0 {
		_, _ = fmt.Fprintln(output, "当前没有活跃的持久会话。")
		return
	}
	for index, row := range state.rows {
		marker := "  "
		if index == state.selected {
			marker = "> "
		}
		line := fmt.Sprintf(
			"%s%s  %-12s %-16s %s",
			marker,
			globalSessionStatus(row),
			row.Provider,
			globalSessionAccount(row, labels),
			globalSessionTitle(row),
		)
		_, _ = fmt.Fprintf(output, "%s\r\n", line)
	}
	if state.detail {
		if row := state.current(); row != nil {
			_, _ = fmt.Fprintln(output, "\r\n详情：")
			_, _ = fmt.Fprintf(output, "  provider: %s\r\n", row.Provider)
			_, _ = fmt.Fprintf(output, "  账号: %s\r\n", globalSessionAccount(*row, labels))
			_, _ = fmt.Fprintf(output, "  状态: %s\r\n", globalSessionStatus(*row))
			_, _ = fmt.Fprintf(output, "  路径: %s\r\n", row.Path)
			_, _ = fmt.Fprintf(output, "  运行时: socket=%s pane=%s\r\n", row.Socket, globalSessionID(*row))
			native := strings.TrimSpace(row.NativeID)
			if native == "" {
				native = "(未知)"
			}
			_, _ = fmt.Fprintf(output, "  原生会话 id: %s\r\n", native)
			_, _ = fmt.Fprintln(output, "  再按 d 返回列表")
		}
	}
	if state.toast != "" {
		_, _ = fmt.Fprintf(output, "\r\n%s\r\n", state.toast)
	}
}

// pickerSessions 是选择器需要的存储端口（便于单测注入）。
type pickerSessions interface {
	Rows(ctx context.Context) ([]persistent.SessionRow, error)
	Close(ctx context.Context, row persistent.SessionRow) error
}

// runSessionPicker 进入原始模式并在原地重绘；Enter 会先恢复终端再 attach。
func runSessionPicker(
	ctx context.Context,
	runtime commandRuntime,
	sessions pickerSessions,
	labels map[string]string,
) error {
	file, ok := runtime.stdin.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return fmt.Errorf("%w: 交互选择需要真实终端", errInvalidCommand)
	}
	rows, err := sessions.Rows(ctx)
	if err != nil {
		return err
	}
	state := newPickerState(rows)
	previous, err := term.MakeRaw(int(file.Fd()))
	if err != nil {
		return err
	}
	restore := func() { _ = term.Restore(int(file.Fd()), previous) }
	defer restore()
	_, _ = io.WriteString(runtime.stdout, "\x1b[?25l")
	defer func() { _, _ = io.WriteString(runtime.stdout, "\x1b[?25h\x1b[2J\x1b[H") }()

	buffer := make([]byte, 8)
	for {
		_, _ = io.WriteString(runtime.stdout, "\x1b[2J\x1b[H")
		renderPicker(runtime.stdout, state, labels)
		count, readErr := file.Read(buffer)
		if readErr != nil {
			return readErr
		}
		key := parsePickerKey(buffer[:count])
		action := state.handleKey(key)
		switch action {
		case pickerQuit:
			return nil
		case pickerAttach:
			row := state.current()
			if row == nil {
				continue
			}
			restore()
			_, _ = io.WriteString(runtime.stdout, "\x1b[?25h\x1b[2J\x1b[H")
			return attachPersistentSession(ctx, *row, runtime)
		case pickerCopyID:
			row := state.current()
			if row == nil {
				continue
			}
			state.toast = copyToClipboard(pickerCopyText(*row))
		case pickerCopyCommand:
			row := state.current()
			if row == nil {
				continue
			}
			state.toast = copyToClipboard(pickerResumeCommand(*row))
		case pickerClose:
			row := state.current()
			if row == nil {
				continue
			}
			if closeErr := sessions.Close(ctx, *row); closeErr != nil {
				state.toast = "关闭失败: " + closeErr.Error()
			} else {
				state.toast = "已关闭 " + row.Name
			}
			if refreshed, refreshErr := sessions.Rows(ctx); refreshErr == nil {
				state.rows = refreshed
				state.move(0)
			}
		case pickerCloseIdle:
			closed := 0
			for _, row := range append([]persistent.SessionRow(nil), state.rows...) {
				if row.Live {
					continue
				}
				if closeErr := sessions.Close(ctx, row); closeErr == nil {
					closed++
				}
			}
			state.toast = fmt.Sprintf("已关闭 %d 个空闲会话", closed)
			if refreshed, refreshErr := sessions.Rows(ctx); refreshErr == nil {
				state.rows = refreshed
				state.move(0)
			}
		}
	}
}

// parsePickerKey 把原始字节解析成具名按键（方向键为 ESC [ A/B）。
func parsePickerKey(buffer []byte) string {
	text := string(buffer)
	switch text {
	case "\x1b[A":
		return "up"
	case "\x1b[B":
		return "down"
	case "\x1b":
		return "esc"
	case "\r", "\n":
		return "enter"
	case "\x03":
		return "ctrl-c"
	}
	if len(buffer) == 1 {
		return text
	}
	return ""
}

// copyToClipboard 按平台选择剪贴板命令；不可用时返回提示而不是失败退出。
func copyToClipboard(value string) string {
	if strings.TrimSpace(value) == "" {
		return "没有可复制的内容"
	}
	candidates := [][]string{
		{"pbcopy"},
		{"wl-copy"},
		{"xclip", "-selection", "clipboard"},
		{"clip.exe"},
	}
	for _, candidate := range candidates {
		path, err := exec.LookPath(candidate[0])
		if err != nil {
			continue
		}
		command := exec.Command(path, candidate[1:]...)
		command.Stdin = strings.NewReader(value)
		if err := command.Run(); err == nil {
			return "已复制: " + value
		}
	}
	return "剪贴板命令不可用"
}
