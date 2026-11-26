package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/terminalui"

	"golang.org/x/term"
)

const (
	lsTickInterval      = 100 * time.Millisecond
	lsRefreshInterval   = time.Second
	lsActivityReadEvery = 500 * time.Millisecond
	lsEscapeDelay       = 500 * time.Millisecond
	lsDominoFrameEvery  = 250 * time.Millisecond
	lsDominoSteps       = 5
	lsDominoMaxLines    = 5
	lsDominoMinWidth    = 8
	lsPrefixWidth       = 4
	lsMaxFrameStep      = 4
)

var (
	lsBrailleFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	lsASCIIFrames   = []string{"|", "/", "-", "\\"}
	lsDominoGlyphs  = []string{"\\", "/", "|"}
)

// lsExitCode 是交互列表透传的静默退出码（Ctrl+C=130）。
type lsExitCode int

func (code lsExitCode) Error() string { return "" }
func (code lsExitCode) ExitCode() int { return int(code) }
func (code lsExitCode) SilentExit()   {}

type lsDomino struct {
	target string
	frame  int
	step   int
}

type lsRowLayout struct {
	text   string
	width  int
	indent int
	lines  []terminalui.Line
}

type lsAnimation struct {
	ctx         context.Context
	runtime     commandRuntime
	palette     terminalPalette
	stdin       *os.File
	stdout      io.Writer
	cols        int
	rows        int
	load        func() (*lsData, error)
	query       string
	editing     bool
	data        *lsData
	targets     []string
	rowKeys     []string
	layouts     []lsRowLayout
	lastQuery   string
	offset      int
	scrollStart int
	scrollEnd   int
	scrollTotal int
	screen      terminalui.Frame
	paintErr    error
	frameIdx    []int
	dominoes    map[int]*lsDomino
	lastAdv     time.Time
	activities  map[string]lsActivity
	activityAt  time.Time
	escPending  bool
	escDeadline time.Time
	start       time.Time
	aiHomeDir   string
}

// runLSAnimated 在真实 TTY 下接管屏幕；非 TTY 返回 false，由调用方静态输出。
func runLSAnimated(
	ctx context.Context,
	runtime commandRuntime,
	data *lsData,
	load func() (*lsData, error),
	aiHomeDir string,
	palette terminalPalette,
) (bool, error) {
	stdin, ok := runtime.stdin.(*os.File)
	if !ok || !term.IsTerminal(int(stdin.Fd())) || !terminalWriterIsTTY(runtime.stdout) {
		return false, nil
	}
	previous, err := term.MakeRaw(int(stdin.Fd()))
	if err != nil {
		return false, nil
	}
	restore := func() {
		_, _ = io.WriteString(runtime.stdout, "\x1b[?2026l\x1b[0m\r\n")
		_ = term.Restore(int(stdin.Fd()), previous)
	}
	defer restore()

	width, height, err := term.GetSize(int(stdin.Fd()))
	if err != nil || width <= 0 || height <= 0 {
		width, height = 80, 24
	}
	animation := &lsAnimation{
		ctx:       ctx,
		runtime:   runtime,
		palette:   palette,
		stdin:     stdin,
		stdout:    runtime.stdout,
		cols:      width,
		rows:      height,
		load:      load,
		data:      data,
		dominoes:  make(map[int]*lsDomino),
		start:     time.Now(),
		aiHomeDir: aiHomeDir,
	}
	return true, animation.run()
}

func (animation *lsAnimation) run() error {
	keys := make(chan []byte, 8)
	go animation.readKeys(keys)
	dataCh := make(chan *lsData, 1)
	if animation.load != nil {
		go func() {
			if next, err := animation.load(); err == nil && next != nil {
				select {
				case dataCh <- next:
				case <-animation.ctx.Done():
				}
			}
		}()
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGHUP)
	defer signal.Stop(signals)

	ticker := time.NewTicker(lsTickInterval)
	defer ticker.Stop()
	refresh := time.NewTicker(lsRefreshInterval)
	defer refresh.Stop()

	animation.render(false)
	for {
		if animation.paintErr != nil {
			return animation.paintErr
		}
		select {
		case <-animation.ctx.Done():
			animation.render(true)
			return animation.paintErr
		case <-signals:
			return nil
		case next := <-dataCh:
			if next != nil {
				animation.data = next
			}
			animation.render(false)
		case chunk := <-keys:
			if animation.escPending {
				if len(chunk) >= 2 && chunk[0] == 0x1b && (chunk[1] == '[' || chunk[1] == 'O') {
					animation.escPending = false
					animation.handleKeys(chunk)
					animation.render(false)
					continue
				}
				animation.escPending = false
				switch animation.applyEscape() {
				case "quit":
					animation.render(true)
					return animation.paintErr
				}
			}
			action := animation.handleKeys(chunk)
			switch action {
			case "escape-pending":
				animation.escPending = true
				animation.escDeadline = time.Now().Add(lsEscapeDelay)
			case "escape":
				if animation.applyEscape() == "quit" {
					animation.render(true)
					return animation.paintErr
				}
				animation.render(false)
			case "quit":
				animation.render(true)
				return animation.paintErr
			case "interrupt":
				animation.render(true)
				return lsExitCode(130)
			default:
				animation.render(false)
			}
		case <-ticker.C:
			if animation.escPending && time.Now().After(animation.escDeadline) {
				animation.escPending = false
				if animation.applyEscape() == "quit" {
					animation.render(true)
					return animation.paintErr
				}
			}
			animation.render(false)
		case <-refresh.C:
			if animation.load != nil {
				// 刷新放到后台：读库/解析额度不能卡住 100ms 的重绘节拍。
				go func() {
					if next, err := animation.load(); err == nil && next != nil {
						select {
						case dataCh <- next:
						case <-animation.ctx.Done():
						}
					}
				}()
			}
		}
	}
}

func (animation *lsAnimation) readKeys(keys chan<- []byte) {
	buffer := make([]byte, 64)
	for {
		count, err := animation.stdin.Read(buffer)
		if count > 0 {
			chunk := make([]byte, count)
			copy(chunk, buffer[:count])
			select {
			case keys <- chunk:
			case <-animation.ctx.Done():
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (animation *lsAnimation) handleKeys(chunk []byte) string {
	text := string(chunk)
	for len(text) > 0 {
		if text[0] == 0x1b {
			if len(text) == 1 {
				return "escape-pending"
			}
			if text[1] == '[' || text[1] == 'O' {
				start := 2
				index := start
				for index < len(text) {
					if text[index] >= 0x40 && text[index] <= 0x7e {
						index++
						break
					}
					index++
				}
				switch text[start:index] {
				case "A":
					animation.scrollBy(-1)
				case "B":
					animation.scrollBy(1)
				case "5~":
					animation.scrollBy(-animation.pageSize())
				case "6~":
					animation.scrollBy(animation.pageSize())
				case "H":
					animation.offset = 0
				case "F":
					animation.offset = 1 << 30
				}
				text = text[index:]
				continue
			}
			if len(text) >= 2 {
				text = text[1:]
				if animation.editing {
					animation.editing = false
					animation.query = ""
					return "redraw"
				}
				if animation.query != "" {
					animation.query = ""
					return "redraw"
				}
				return "quit"
			}
		}
		if text[0] == 0x03 {
			return "interrupt"
		}
		if animation.editing {
			switch text[0] {
			case '\r', '\n':
				animation.editing = false
				text = text[1:]
				continue
			case 0x7f, 0x08:
				if animation.query != "" {
					_, size := utf8.DecodeLastRuneInString(animation.query)
					animation.query = animation.query[:len(animation.query)-size]
				}
				text = text[1:]
				continue
			}
			rune, size := utf8.DecodeRuneInString(text)
			if rune == utf8.RuneError && size == 1 {
				text = text[1:]
				continue
			}
			if rune >= ' ' {
				animation.query += string(rune)
			}
			text = text[size:]
			continue
		}
		switch text[0] {
		case 'q', 'Q':
			return "quit"
		case '/':
			animation.editing = true
			text = text[1:]
			continue
		}
		_, size := utf8.DecodeRuneInString(text)
		if size <= 0 {
			size = 1
		}
		text = text[size:]
	}
	return "redraw"
}

func (animation *lsAnimation) applyEscape() string {
	if animation.editing || animation.query != "" {
		animation.editing = false
		animation.query = ""
		return "redraw"
	}
	return "quit"
}

func (animation *lsAnimation) pageSize() int {
	size := animation.rows - 1
	if size < 1 {
		size = 1
	}
	return size
}

func (animation *lsAnimation) scrollBy(delta int) {
	animation.offset += delta
	if animation.offset < 0 {
		animation.offset = 0
	}
}

func (animation *lsAnimation) statusLine() string {
	scroll := ""
	if animation.scrollTotal > 0 {
		scroll = fmt.Sprintf("%d-%d/%d  ·  ↑↓ 滚动 · PgUp/PgDn 翻页  ·  ", animation.scrollStart+1, animation.scrollEnd, animation.scrollTotal)
	}
	if animation.editing {
		return animation.palette.cyan("/") + animation.query + animation.palette.gray("  Enter 保留 · Esc 清空 · Ctrl+C 退出")
	}
	if animation.query != "" {
		return animation.palette.gray("筛选: " + animation.query + "  ·  " + scroll + "/ 继续输入  ·  Esc 清空  ·  q 退出")
	}
	return animation.palette.gray(scroll + "/ 筛选  ·  q/Esc 退出")
}

func (animation *lsAnimation) render(static bool) {
	if animation.data == nil || animation.paintErr != nil {
		return
	}
	resized := animation.refreshSize()
	if animation.lastQuery != animation.query {
		animation.offset = 0
	}
	if animation.activities == nil || time.Since(animation.activityAt) >= lsActivityReadEvery {
		animation.activities = readLSActivity(animation.aiHomeDir)
		animation.activityAt = time.Now()
	}
	rows := buildLSRows(animation.data, animation.query, animation.palette, !static, animation.start, time.Now())
	if len(animation.frameIdx) != len(rows) {
		animation.frameIdx = make([]int, len(rows))
	}
	targets := make([]string, len(rows))
	rowKeys := make([]string, len(rows))
	newSnapshot := static || animation.lastQuery != animation.query || len(animation.rowKeys) != len(rows)
	for index, row := range rows {
		rowKeys[index] = row.kind + ":" + row.provider
		if row.account != nil {
			rowKeys[index] += ":" + row.account.Account.AccountRef
		}
		if !newSnapshot && rowKeys[index] != animation.rowKeys[index] {
			newSnapshot = true
		}
		targets[index] = row.render(animation.prefixFor(row, index, static))
	}
	if newSnapshot || resized || len(targets) != len(animation.targets) {
		animation.dominoes = make(map[int]*lsDomino)
	} else {
		for index := range targets {
			if animation.dominoes[index] == nil && targets[index] != animation.targets[index] && shouldLSAnimate(targets[index], animation.targets[index]) {
				animation.startDomino(index, targets[index])
			}
		}
	}
	if animation.cols < 4 || animation.rows < 3 {
		animation.renderSizeHint()
		return
	}
	lines, err := animation.layoutRows(rows, targets)
	if err != nil {
		animation.renderSizeHint()
		return
	}
	contentLines := len(lines)
	statusRows := 0
	if !static {
		statusRows = 1
	}
	var visible []string
	var statusLines []terminalui.Line
	for attempt := 0; attempt < 2; attempt++ {
		maxContent := animation.rows - statusRows
		if maxContent < 1 {
			maxContent = 1
		}
		if contentLines <= maxContent {
			animation.offset = 0
		} else if animation.offset > contentLines-maxContent {
			animation.offset = contentLines - maxContent
		}
		if animation.offset < 0 {
			animation.offset = 0
		}
		start := animation.offset
		end := start + maxContent
		if end > contentLines {
			end = contentLines
		}
		animation.scrollStart, animation.scrollEnd, animation.scrollTotal = start, end, contentLines
		status := ""
		if !static {
			status = animation.statusLine()
		}
		statusLines, err = terminalui.Wrap(status, animation.maxWidth(), 0)
		if err != nil {
			animation.renderSizeHint()
			return
		}
		visible = append(visible[:0], lines[start:end]...)
		if len(statusLines) == statusRows {
			break
		}
		statusRows = len(statusLines)
	}
	for _, line := range statusLines {
		visible = append(visible, line.Text)
	}
	animation.paintErr = animation.screen.Present(animation.stdout, visible, animation.cols, animation.rows, static)
	animation.targets = targets
	animation.rowKeys = rowKeys
	animation.lastQuery = animation.query
	animation.advanceDominoes()
}

// Polling on the existing 100ms tick also covers terminals without SIGWINCH
// forwarding and keeps the rendering path portable to Windows.
func (animation *lsAnimation) refreshSize() bool {
	fd := int(animation.stdin.Fd())
	if output, ok := animation.stdout.(interface{ Fd() uintptr }); ok {
		fd = int(output.Fd())
	}
	width, height, err := term.GetSize(fd)
	if err != nil || width <= 0 || height <= 0 {
		return false
	}
	changed := width != animation.cols || height != animation.rows
	animation.cols, animation.rows = width, height
	return changed
}

func (animation *lsAnimation) prefixFor(row lsRow, index int, static bool) string {
	if row.account == nil {
		return "  - "
	}
	activity, exists := animation.activities[row.provider+":"+row.account.Account.AccountRef]
	if !exists || activity.InFlight <= 0 {
		return "  - "
	}
	if static {
		return "  ● "
	}
	frames := lsBrailleFrames
	if isWindowsPlatform() {
		frames = lsASCIIFrames
	}
	step := lsFrameStep(activity)
	if step > 0 {
		animation.frameIdx[index] = (animation.frameIdx[index] + step) % len(frames)
	}
	return "  " + frames[animation.frameIdx[index]] + " "
}

func (animation *lsAnimation) maxWidth() int {
	if animation.cols > 2 {
		return animation.cols - 1
	}
	return 0
}

func (animation *lsAnimation) startDomino(index int, target string) {
	if animation.dominoes[index] == nil && len(animation.dominoes) >= lsDominoMaxLines {
		return
	}
	width := lsVisibleWidth(target) - lsPrefixWidth
	if width < 0 {
		width = 0
	}
	animation.dominoes[index] = &lsDomino{
		target: target,
		frame:  0,
		step:   maxInt(2, (width+lsDominoSteps-1)/lsDominoSteps),
	}
}

// layoutRows fixes physical boundaries before applying animation glyphs, so
// replacing a wide grapheme with ASCII cannot create a new word-wrap point.
func (animation *lsAnimation) layoutRows(rows []lsRow, targets []string) ([]string, error) {
	lines := make([]string, 0, len(targets)+1)
	if len(animation.layouts) != len(targets) {
		animation.layouts = make([]lsRowLayout, len(targets))
	}
	for index, target := range targets {
		indent := 0
		if rows[index].account != nil {
			indent = lsPrefixWidth
		}
		layout := &animation.layouts[index]
		if layout.text != target || layout.width != animation.maxWidth() || layout.indent != indent || layout.lines == nil {
			wrapped, err := terminalui.Wrap(target, animation.maxWidth(), indent)
			if err != nil {
				return nil, err
			}
			*layout = lsRowLayout{text: target, width: animation.maxWidth(), indent: indent, lines: wrapped}
		}
		state := animation.dominoes[index]
		if state != nil && stripLSPrefix(state.target) != stripLSPrefix(target) {
			delete(animation.dominoes, index)
			animation.startDomino(index, target)
			state = animation.dominoes[index]
		}
		offset, glyph := 0, 0
		for _, part := range layout.lines {
			line, padding, width := part.Text, part.Indent, part.Width
			if state != nil && state.frame < lsDominoSteps && glyph < len(lsDominoGlyphs) {
				start := max(padding, lsPrefixWidth+state.frame*state.step-offset+padding)
				if start < width {
					var used int
					line, used = terminalui.ReplaceCells(line, start, lsDominoGlyphs[glyph:])
					glyph += used
				}
			}
			lines = append(lines, line)
			offset += width - padding
		}
	}
	return lines, nil
}

func (animation *lsAnimation) renderSizeHint() {
	hint := "Terminal too small; enlarge to show accounts."
	if animation.cols <= len(hint) {
		hint = "!"
	}
	animation.paintErr = animation.screen.Present(animation.stdout, []string{hint}, animation.cols, animation.rows, false)
	animation.dominoes = make(map[int]*lsDomino)
}

func stripLSPrefix(value string) string {
	// 前缀是 4 个显示列：两个空格、一个转圈 glyph（Braille 是 3 字节/1 个 rune）、
	// 一个空格。必须按 rune 切，不能按 byte 切，否则会把 Braille 劈成半个。
	runes := []rune(value)
	if len(runes) <= lsPrefixWidth {
		return ""
	}
	return string(runes[lsPrefixWidth:])
}

func (animation *lsAnimation) advanceDominoes() {
	if len(animation.dominoes) == 0 {
		animation.lastAdv = time.Time{}
		return
	}
	now := time.Now()
	if !animation.lastAdv.IsZero() && now.Sub(animation.lastAdv) < lsDominoFrameEvery {
		return
	}
	animation.lastAdv = now
	for index, state := range animation.dominoes {
		state.frame++
		if state.frame > lsDominoSteps {
			delete(animation.dominoes, index)
		}
	}
}

func shouldLSAnimate(target string, previous string) bool {
	if previous == "" {
		return false
	}
	if stripLSPrefix(target) == stripLSPrefix(previous) {
		return false
	}
	return lsVisibleWidth(target) >= lsDominoMinWidth
}

func lsFrameStep(activity lsActivity) int {
	step := (activity.Rate + 2) / 3
	if step < 1 {
		step = 1
	}
	if step > lsMaxFrameStep {
		step = lsMaxFrameStep
	}
	return step
}

func isWindowsPlatform() bool {
	return os.PathSeparator == '\\'
}

func lsVisibleWidth(value string) int { return terminalui.Width(value) }
