package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

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
	pickerToggleExpand
)

// pickerState 是选择器的纯状态：选中项、详情开关与提示行。
// 交互循环只负责读键、恢复终端与执行动作，渲染/移动都可以单测。
type pickerState struct {
	rows     []persistent.SessionRow
	selected int
	detail   bool
	toast    string
	// animationFrame 驱动运行中转圈；headerFrame 驱动切项目时的目录动效。
	animationFrame int
	activeProject  string
	headerFrame    int
	// dismissed 记录本次 picker 里 x/X 移除的已结束会话，防止并发刷新
	// 在关闭动作之后又把同一行带回来。
	dismissed map[string]bool
	// loading 表示首帧来自空缓存、完整采集仍在后台跑。
	loading bool
	// expanded 记录主会话是否展开 subagent 子行；默认全部折叠。
	expanded map[string]bool
}

func newPickerState(rows []persistent.SessionRow) *pickerState {
	state := &pickerState{rows: rows, loading: len(rows) == 0, expanded: make(map[string]bool)}
	state.syncActiveProject()
	return state
}

func (state *pickerState) syncActiveProject() {
	row := state.current()
	if row == nil {
		state.activeProject = ""
		return
	}
	project := sessionProjectPath(*row)
	if project != state.activeProject {
		state.activeProject = project
		state.headerFrame = 0
	}
}

func (state *pickerState) move(delta int) {
	visible := state.visibleRows()
	if len(visible) == 0 {
		state.selected = 0
		return
	}
	next := state.selected + delta
	if next < 0 {
		next = 0
	}
	if next >= len(visible) {
		next = len(visible) - 1
	}
	state.selected = next
	state.syncActiveProject()
}

func (state *pickerState) current() *persistent.SessionRow {
	visible := state.visibleRows()
	if state.selected < 0 || state.selected >= len(visible) {
		return nil
	}
	return &visible[state.selected]
}

// visibleRows 返回主行 + 已展开 main 的 subagent 子行；子行没有父行时
// 作为孤儿主行显示，避免数据缺失时会话彻底消失。
func (state *pickerState) visibleRows() []persistent.SessionRow {
	if len(state.rows) == 0 {
		return nil
	}
	ids := make(map[string]bool, len(state.rows))
	for _, row := range state.rows {
		if id := strings.TrimSpace(row.NativeID); id != "" {
			ids[id] = true
		}
	}
	children := make(map[string][]persistent.SessionRow)
	main := make([]persistent.SessionRow, 0, len(state.rows))
	for _, row := range state.rows {
		if row.Subagent {
			parent := strings.TrimSpace(row.ParentID)
			if parent != "" && ids[parent] {
				children[parent] = append(children[parent], row)
			}
			// 父会话不在本次列表时不能把 subagent 顶成主行；
			// 宁可暂时不显示，也不让用户误以为是独立会话。
			continue
		}
		main = append(main, row)
	}
	visible := make([]persistent.SessionRow, 0, len(state.rows))
	for _, row := range main {
		visible = append(visible, row)
		if state.expanded[strings.TrimSpace(row.NativeID)] {
			visible = append(visible, children[strings.TrimSpace(row.NativeID)]...)
		}
	}
	return visible
}

func (state *pickerState) childCount(parentID string) int {
	count := 0
	for _, row := range state.rows {
		if row.Subagent && strings.TrimSpace(row.ParentID) == strings.TrimSpace(parentID) {
			count++
		}
	}
	return count
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
	case " ":
		if row := state.current(); row != nil && state.childCount(row.NativeID) > 0 {
			state.expanded[strings.TrimSpace(row.NativeID)] = !state.expanded[strings.TrimSpace(row.NativeID)]
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

// renderPicker 输出整屏（兼容既有调用方与测试）。
func renderPicker(
	output io.Writer,
	state *pickerState,
	labels map[string]string,
) {
	for _, line := range buildPickerLines(state, labels, 100) {
		_, _ = fmt.Fprintf(output, "%s\r\n", line)
	}
}

// pickerColumnLayout 是选择器的固定列宽；标题列吃掉剩余宽度。
type pickerColumnLayout struct {
	status   int
	provider int
	account  int
	title    int
	latest   int
	id       int
	updated  int
}

func resolvePickerLayout(width int) pickerColumnLayout {
	if width <= 0 {
		width = 100
	}
	if width > 240 {
		width = 240
	}
	layout := pickerColumnLayout{status: 4, provider: 11, account: 12, id: 8, updated: 5}
	if width >= 84 {
		layout.latest = 24
	}
	if width >= 96 {
		layout.latest = 28
	}
	if width >= 118 {
		layout.latest = 34
	}
	// 先保标题；窗口越窄越先丢辅助列。最新消息比 ID/更新时间更重要，
	// 所以 80~95 列优先保留最新消息，先牺牲 ID 和更新时间。
	for {
		fixed := 2 + layout.status + layout.provider + layout.account + layout.latest + layout.id + layout.updated + 6*2
		layout.title = width - fixed
		if layout.title >= 18 {
			break
		}
		if layout.updated > 0 {
			layout.updated = 0
			continue
		}
		if layout.id > 0 {
			layout.id = 0
			continue
		}
		if layout.latest > 0 {
			layout.latest = 0
			continue
		}
		if layout.account > 0 {
			layout.account = 0
			continue
		}
		if layout.provider > 0 {
			layout.provider = 0
			continue
		}
		layout.title = maxInt(1, width-2-layout.status)
		break
	}
	return layout
}

var runningSpinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
var waitingSpinnerFrames = []string{"◐", "◓", "◑", "◒"}
var projectRainbowColors = []int{196, 202, 226, 46, 51, 33, 129}

// buildPickerLines 生成一帧的纯文本行（颜色只包在单元格内部，宽度按
// 可见字符计算，避免中文/ANSI 导致列错位）。
func buildPickerLines(state *pickerState, labels map[string]string, width int) []string {
	lines, _ := buildPickerFrame(state, labels, width)
	return lines
}

// buildPickerFrame 额外返回选中行在整帧里的行号，供终端变矮时滚动窗口。
func buildPickerFrame(state *pickerState, labels map[string]string, width int) ([]string, int) {
	layout := resolvePickerLayout(width)
	visible := state.visibleRows()
	lines := make([]string, 0, len(visible)+8)
	selectedLine := 0
	header := fmt.Sprintf("[aih] 活跃持久会话（%d）", len(visible))
	legend := "  \x1b[32m⠿\x1b[0m 运行中  \x1b[33m◐\x1b[0m 等待输入  \x1b[90m○\x1b[0m 空闲  \x1b[90m✕\x1b[0m 已结束"
	lines = append(lines, truncateDisplayPreservingANSI(header+legend, width))
	hints := "↑/↓ 选择 · Space 展开 · Enter 进入 · d 详情 · c 复制ID · y 复制命令 · x 关闭 · X 关空闲/已结束 · q 退出"
	if displayWidth(hints) > width {
		hints = "↑/↓ · Space · Enter · d · c · y · x · X · q"
	}
	lines = append(lines, truncateDisplayPreservingANSI("\x1b[90m"+hints+"\x1b[0m", width))
	if len(visible) == 0 {
		if state.loading {
			lines = append(lines, "正在加载会话…")
		} else {
			lines = append(lines, "当前没有活跃的持久会话。")
		}
		return lines, selectedLine
	}
	lines = append(lines, formatPickerTableHeader(layout, width))

	projectCounts := make(map[string]int, len(visible))
	for _, row := range visible {
		projectCounts[sessionProjectPath(row)]++
	}
	currentProject := ""
	for index, row := range visible {
		project := sessionProjectPath(row)
		if project != currentProject {
			if currentProject != "" {
				lines = append(lines, "")
			}
			lines = append(lines, formatPickerProjectHeader(project, projectCounts[project], width, project == state.activeProject, state.headerFrame))
			currentProject = project
		}
		if index == state.selected {
			selectedLine = len(lines)
		}
		depth := 0
		if row.Subagent && state.childCount(row.ParentID) > 0 {
			depth = 1
		}
		accent := state.childCount(row.NativeID) > 0
		lines = append(lines, formatPickerRow(row, index == state.selected, labels, layout, width, state.animationFrame, depth, accent, state.expanded[strings.TrimSpace(row.NativeID)]))
	}
	if state.detail {
		if row := state.current(); row != nil {
			lines = append(lines, "", "\x1b[1m详情\x1b[0m")
			lines = append(lines, "  provider: "+row.Provider)
			lines = append(lines, "  账号: "+globalSessionAccount(*row, labels))
			lines = append(lines, "  状态: "+globalSessionStatus(*row))
			lines = append(lines, "  最新消息: "+pickerLatestMessage(*row))
			lines = append(lines, "  路径: "+row.Path)
			lines = append(lines, fmt.Sprintf("  运行时: socket=%s pane=%s", row.Socket, globalSessionID(*row)))
			native := strings.TrimSpace(row.NativeID)
			if native == "" {
				native = "(未知)"
			}
			lines = append(lines, "  原生会话 id: "+native, "  再按 d 返回列表")
		}
	}
	if state.toast != "" {
		lines = append(lines, "", state.toast)
	}
	return lines, selectedLine
}

func formatPickerTableHeader(layout pickerColumnLayout, width int) string {
	line := "  " + padDisplay("状态", layout.status)
	if layout.provider > 0 {
		line += " " + padDisplay("provider", layout.provider)
	}
	if layout.account > 0 {
		line += " " + padDisplay("账号", layout.account)
	}
	line += " " + padDisplay("会话名称", layout.title)
	if layout.latest > 0 {
		line += "  " + padDisplay("最新消息", layout.latest)
	}
	if layout.id > 0 {
		line += "  " + padDisplay("会话ID", layout.id)
	}
	if layout.updated > 0 {
		line += "  " + padDisplay("更新", layout.updated)
	}
	return truncateDisplayPreservingANSI("\x1b[90m"+line+"\x1b[0m", width)
}

func formatPickerProjectHeader(project string, count int, width int, active bool, frame int) string {
	label := "▸ " + project
	if count > 0 {
		label += fmt.Sprintf("  (%d)", count)
	}
	label = truncateDisplay(label, width)
	if !active {
		return "\x1b[36m" + label + "\x1b[0m"
	}
	if frame >= 0 && frame < len(projectRainbowColors) {
		var builder strings.Builder
		for index, char := range label {
			color := projectRainbowColors[(index+frame)%len(projectRainbowColors)]
			builder.WriteString(fmt.Sprintf("\x1b[38;5;%dm%c", color, char))
		}
		builder.WriteString("\x1b[0m")
		return builder.String()
	}
	return "\x1b[1;36m" + label + "\x1b[0m"
}

func formatPickerRow(
	row persistent.SessionRow,
	selected bool,
	labels map[string]string,
	layout pickerColumnLayout,
	width int,
	frame int,
	depth int,
	hasChildren bool,
	expanded bool,
) string {
	marker := "  "
	if selected {
		marker = "\x1b[36m> \x1b[0m"
	}
	status := globalSessionState(row)
	icon := statusIcon(status, frame)
	statusCell := icon + strings.Repeat(" ", maxInt(0, layout.status-displayWidth(status.Icon)))
	provider := padDisplay(truncateDisplay(row.Provider, layout.provider), layout.provider)
	account := ""
	if layout.account > 0 {
		account = padDisplay(truncateDisplay(globalSessionAccount(row, labels), layout.account), layout.account)
	}
	displayTitle := globalSessionTitle(row)
	if depth > 0 {
		prefix := "  ↳ "
		if name := strings.TrimSpace(row.AgentName); name != "" {
			prefix += name + " · "
		}
		displayTitle = prefix + displayTitle
	} else if hasChildren {
		if expanded {
			displayTitle = "▾ " + displayTitle
		} else {
			displayTitle = "▸ " + displayTitle
		}
	}
	title := padDisplay(truncateDisplay(displayTitle, layout.title), layout.title)
	if selected {
		title = "\x1b[1m" + title + "\x1b[0m"
	}
	line := marker + statusCell
	if layout.provider > 0 {
		line += " " + provider
	}
	if layout.account > 0 {
		line += " " + account
	}
	line += " " + title
	if layout.latest > 0 {
		line += "  " + padDisplay(truncateDisplay(pickerLatestMessage(row), layout.latest), layout.latest)
	}
	if layout.id > 0 {
		line += "  " + padDisplay(truncateDisplay(shortSessionID(row.NativeID), layout.id), layout.id)
	}
	if layout.updated > 0 {
		line += "  " + padDisplay(truncateDisplay(pickerActivityLabel(row), layout.updated), layout.updated)
	}
	return truncateDisplayPreservingANSI(line, width)
}

func pickerLatestMessage(row persistent.SessionRow) string {
	text := strings.TrimSpace(row.LastMessage)
	if text == "" {
		return "-"
	}
	role := strings.TrimSpace(row.LastMessageRole)
	if role != "" {
		return role + " · " + text
	}
	return text
}

func pickerActivityLabel(row persistent.SessionRow) string {
	millis := sessionActivityMillis(row)
	if millis <= 0 {
		return "-"
	}
	value := time.UnixMilli(millis)
	if time.Now().Format("2006-01-02") == value.Format("2006-01-02") {
		return value.Format("15:04")
	}
	return value.Format("01-02")
}

func statusIcon(status sessionStatus, frame int) string {
	color := "90"
	icon := status.Icon
	switch status.Kind {
	case "running":
		color = "32"
		icon = runningSpinnerFrames[frame%len(runningSpinnerFrames)]
	case "waiting":
		color = "33"
		icon = waitingSpinnerFrames[frame%len(waitingSpinnerFrames)]
	case "ended":
		icon = "✕"
	}
	return "\x1b[" + color + "m" + icon + "\x1b[0m"
}

// truncateDisplay 按终端显示宽度截断（中文按两列），末尾补 …。
func truncateDisplay(text string, width int) string {
	value := strings.Join(strings.Fields(text), " ")
	if width <= 0 || value == "" {
		return ""
	}
	if displayWidth(value) <= width {
		return value
	}
	if width == 1 {
		return "…"
	}
	var builder strings.Builder
	used := 0
	for _, char := range value {
		next := displayRuneWidth(char)
		if used+next > width-1 {
			break
		}
		builder.WriteRune(char)
		used += next
	}
	return builder.String() + "…"
}

// truncateDisplayPreservingANSI 只用于已经带颜色的整行：ANSI 转义序列
// 不占显示宽度，截断时原样保留。
func truncateDisplayPreservingANSI(text string, width int) string {
	if displayWidth(stripANSI(text)) <= width {
		return text
	}
	var builder strings.Builder
	used := 0
	for index := 0; index < len(text); {
		if text[index] == 0x1b && index+1 < len(text) && text[index+1] == '[' {
			end := index + 2
			for end < len(text) && !(text[end] >= 'A' && text[end] <= 'Z') && !(text[end] >= 'a' && text[end] <= 'z') {
				end++
			}
			if end < len(text) {
				end++
			}
			builder.WriteString(text[index:end])
			index = end
			continue
		}
		r, size := utf8.DecodeRuneInString(text[index:])
		next := displayRuneWidth(r)
		if used+next > width-1 {
			break
		}
		builder.WriteString(text[index : index+size])
		used += next
		index += size
	}
	builder.WriteString("…\x1b[0m")
	return builder.String()
}

func padDisplay(text string, width int) string {
	padding := width - displayWidth(text)
	if padding <= 0 {
		return text
	}
	return text + strings.Repeat(" ", padding)
}

func displayWidth(text string) int {
	width := 0
	for _, char := range stripANSI(text) {
		width += displayRuneWidth(char)
	}
	return width
}

func displayRuneWidth(char rune) int {
	switch {
	case char < 0x1100:
		return 1
	case char <= 0x115f:
		return 2
	case char == 0x2329 || char == 0x232a:
		return 2
	case char >= 0x2e80 && char <= 0xa4cf && char != 0x303f:
		return 2
	case char >= 0xac00 && char <= 0xd7a3:
		return 2
	case char >= 0xf900 && char <= 0xfaff:
		return 2
	case char >= 0xfe30 && char <= 0xfe6f:
		return 2
	case char >= 0xff00 && char <= 0xff60:
		return 2
	case char >= 0xffe0 && char <= 0xffe6:
		return 2
	default:
		return 1
	}
}

func stripANSI(text string) string {
	if !strings.Contains(text, "\x1b[") {
		return text
	}
	var builder strings.Builder
	for index := 0; index < len(text); {
		if text[index] == 0x1b && index+1 < len(text) && text[index+1] == '[' {
			index += 2
			for index < len(text) && !(text[index] >= 'A' && text[index] <= 'Z') && !(text[index] >= 'a' && text[index] <= 'z') {
				index++
			}
			if index < len(text) {
				index++
			}
			continue
		}
		builder.WriteByte(text[index])
		index++
	}
	return builder.String()
}

// pickerSessions 是选择器需要的存储端口（便于单测注入）。
type pickerSessions interface {
	Rows(ctx context.Context) ([]persistent.SessionRow, error)
	Close(ctx context.Context, row persistent.SessionRow) error
	Dismiss(ctx context.Context, row persistent.SessionRow) error
}

// runSessionPicker 进入原始模式并在原地重绘；Enter 会先恢复终端再 attach。
func runSessionPicker(
	ctx context.Context,
	runtime commandRuntime,
	sessions pickerSessions,
	rows []persistent.SessionRow,
	labels map[string]string,
) error {
	file, ok := runtime.stdin.(*os.File)
	if !ok || !term.IsTerminal(int(file.Fd())) {
		return fmt.Errorf("%w: 交互选择需要真实终端", errInvalidCommand)
	}
	state := newPickerState(rows)
	previous, err := term.MakeRaw(int(file.Fd()))
	if err != nil {
		return err
	}
	restore := func() { _ = term.Restore(int(file.Fd()), previous) }
	defer restore()
	_, _ = io.WriteString(runtime.stdout, "\x1b[?25l")
	defer func() { _, _ = io.WriteString(runtime.stdout, "\x1b[?25h\r\n") }()

	width, height := terminalSize(runtime.stdout)
	previousLines := []string(nil)
	draw := func() {
		lines, selectedLine := buildPickerFrame(state, labels, width)
		lines, _ = fitPickerFrame(lines, selectedLine, height)
		if previousLines == nil {
			_, _ = io.WriteString(runtime.stdout, "\x1b[2J\x1b[H")
		}
		for index, line := range lines {
			if index < len(previousLines) && previousLines[index] == line {
				continue
			}
			_, _ = fmt.Fprintf(runtime.stdout, "\x1b[%d;1H%s\x1b[K", index+1, line)
		}
		if len(lines) < len(previousLines) {
			_, _ = fmt.Fprintf(runtime.stdout, "\x1b[%d;1H\x1b[J", len(lines)+1)
		}
		previousLines = append(previousLines[:0], lines...)
	}

	keyCh := make(chan []byte, 8)
	go func() {
		buffer := make([]byte, 8)
		for {
			count, readErr := file.Read(buffer)
			if readErr != nil {
				close(keyCh)
				return
			}
			payload := append([]byte(nil), buffer[:count]...)
			keyCh <- payload
		}
	}()

	animationTicker := time.NewTicker(120 * time.Millisecond)
	defer animationTicker.Stop()
	refreshTicker := time.NewTicker(2 * time.Second)
	defer refreshTicker.Stop()
	refreshCh := make(chan []persistent.SessionRow, 1)
	refreshInFlight := false
	requestRefresh := func() {
		if refreshInFlight {
			return
		}
		refreshInFlight = true
		go func() {
			refreshed, refreshErr := sessions.Rows(ctx)
			if refreshErr != nil {
				refreshed = nil
			}
			select {
			case refreshCh <- refreshed:
			default:
			}
		}()
	}

	requestRefresh()
	draw()
	for {
		select {
		case payload, open := <-keyCh:
			if !open || payload == nil {
				return nil
			}
			key := parsePickerKey(payload)
			selectedKey := ""
			if current := state.current(); current != nil {
				selectedKey = sessionRowKey(*current)
			}
			action := state.handleKey(key)
			switch action {
			case pickerQuit:
				_, _ = io.WriteString(runtime.stdout, "\r\n")
				return nil
			case pickerAttach:
				row := state.current()
				if row == nil {
					continue
				}
				restore()
				_, _ = io.WriteString(runtime.stdout, "\x1b[?25h\x1b[2J\x1b[H")
				if row.NativeOnly {
					return launchNativeSession(ctx, *row, runtime)
				}
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
				if row.NativeOnly && !row.Live {
					if dismissErr := sessions.Dismiss(ctx, *row); dismissErr != nil {
						state.toast = "移除失败: " + dismissErr.Error()
					} else {
						state.toast = "已从列表移除（sessions --history 仍可找回）"
						state.markDismissed(*row)
						state.removeKeys(map[string]bool{selectedKey: true})
					}
				} else if closeErr := sessions.Close(ctx, *row); closeErr != nil {
					state.toast = "关闭失败: " + closeErr.Error()
				} else {
					state.toast = "已关闭 " + row.Name
					state.removeKeys(map[string]bool{selectedKey: true})
				}
				requestRefresh()
			case pickerCloseIdle:
				closed := 0
				dismissed := 0
				removed := make(map[string]bool)
				for _, row := range append([]persistent.SessionRow(nil), state.rows...) {
					if row.Live {
						continue
					}
					if row.NativeOnly {
						if dismissErr := sessions.Dismiss(ctx, row); dismissErr == nil {
							dismissed++
							state.markDismissed(row)
							removed[sessionRowKey(row)] = true
						}
						continue
					}
					if closeErr := sessions.Close(ctx, row); closeErr == nil {
						closed++
						removed[sessionRowKey(row)] = true
					}
				}
				state.toast = fmt.Sprintf("已关闭 %d 个空闲，移除 %d 个已结束", closed, dismissed)
				state.removeKeys(removed)
				requestRefresh()
			}
		case <-animationTicker.C:
			newWidth, newHeight := terminalSize(runtime.stdout)
			if newWidth != width || newHeight != height {
				width, height = newWidth, newHeight
				previousLines = nil
				draw()
				continue
			}
			state.animationFrame++
			headerAnimating := state.headerFrame < len(projectRainbowColors)
			if headerAnimating {
				state.headerFrame++
			}
			if hasAnimatedSessionRows(state.rows) || headerAnimating {
				draw()
			}
		case <-refreshTicker.C:
			requestRefresh()
		case refreshed := <-refreshCh:
			refreshInFlight = false
			state.loading = false
			if refreshed == nil {
				state.toast = "刷新失败，稍后重试"
				draw()
				continue
			}
			selectedKey := ""
			if current := state.current(); current != nil {
				selectedKey = sessionRowKey(*current)
			}
			state.rows = state.filterDismissedRows(refreshed)
			state.selectByKey(selectedKey)
			state.syncActiveProject()
			draw()
		}
	}
}

// fitPickerFrame 在终端变矮时只渲染一个窗口，保证选中行始终可见，
// 且总行数不超过终端高度，避免绝对定位写穿屏幕导致滚动错乱。
func fitPickerFrame(lines []string, selectedLine int, height int) ([]string, int) {
	if height <= 0 || len(lines) <= height {
		return lines, selectedLine
	}
	const fixedTop = 3
	if height <= fixedTop {
		limit := height
		if limit > len(lines) {
			limit = len(lines)
		}
		return lines[:limit], 0
	}
	available := height - fixedTop
	body := lines[fixedTop:]
	selectedBody := selectedLine - fixedTop
	if selectedBody < 0 {
		selectedBody = 0
	}
	start := selectedBody - available + 1
	if start < 0 {
		start = 0
	}
	if start > len(body)-available {
		start = len(body) - available
	}
	if start < 0 {
		start = 0
	}
	window := append([]string(nil), body[start:start+available]...)
	if start > 0 && len(window) > 0 {
		window[0] = "\x1b[90m  ↑ 上方还有会话\x1b[0m"
	}
	result := append(append([]string(nil), lines[:fixedTop]...), window...)
	return result, fixedTop + (selectedBody - start)
}

func hasAnimatedSessionRows(rows []persistent.SessionRow) bool {
	for _, row := range rows {
		kind := globalSessionState(row).Kind
		if kind == "running" || kind == "waiting" {
			return true
		}
	}
	return false
}

func (state *pickerState) markDismissed(row persistent.SessionRow) {
	if state.dismissed == nil {
		state.dismissed = make(map[string]bool)
	}
	state.dismissed[sessionRowKey(row)] = true
}

func (state *pickerState) filterDismissedRows(rows []persistent.SessionRow) []persistent.SessionRow {
	if len(rows) == 0 || len(state.dismissed) == 0 {
		return rows
	}
	selected := make([]persistent.SessionRow, 0, len(rows))
	for _, row := range rows {
		if !row.Live && state.dismissed[sessionRowKey(row)] {
			continue
		}
		selected = append(selected, row)
	}
	return selected
}

func (state *pickerState) removeKeys(keys map[string]bool) {
	if len(keys) == 0 {
		return
	}
	selectedKey := ""
	if current := state.current(); current != nil {
		selectedKey = sessionRowKey(*current)
	}
	filtered := make([]persistent.SessionRow, 0, len(state.rows))
	for _, row := range state.rows {
		if keys[sessionRowKey(row)] {
			continue
		}
		filtered = append(filtered, row)
	}
	state.rows = filtered
	state.selectByKey(selectedKey)
	state.syncActiveProject()
}

func terminalSize(writer io.Writer) (int, int) {
	if file, ok := writer.(*os.File); ok {
		if columns, rows, err := term.GetSize(int(file.Fd())); err == nil && columns > 0 && rows > 0 {
			return columns, rows
		}
	}
	return 100, 40
}

func sessionRowKey(row persistent.SessionRow) string {
	return strings.ToLower(strings.TrimSpace(row.Provider)) + "\x00" + strings.TrimSpace(row.NativeID) + "\x00" + strings.TrimSpace(row.Name)
}

func (state *pickerState) selectByKey(key string) {
	if key != "" {
		visible := state.visibleRows()
		for index := range visible {
			if sessionRowKey(visible[index]) == key {
				state.selected = index
				return
			}
		}
	}
	state.move(0)
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
