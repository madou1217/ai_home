package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

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
	painted     []string
	frameIdx    []int
	dominoes    map[int]*lsDomino
	lastAdv     time.Time
	activities  map[string]lsActivity
	activityAt  time.Time
	escPending  bool
	escDeadline time.Time
	start       time.Time
	aiHomeDir   string
	writeMu     sync.Mutex
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
		_ = term.Restore(int(stdin.Fd()), previous)
		_, _ = fmt.Fprintln(runtime.stdout)
	}
	defer restore()

	width, height, err := term.GetSize(int(stdin.Fd()))
	if err != nil {
		width, height = 0, 0
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
		select {
		case <-animation.ctx.Done():
			animation.render(true)
			return nil
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
					return nil
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
					return nil
				}
				animation.render(false)
			case "quit":
				animation.render(true)
				return nil
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
					return nil
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
				index := 2
				for index < len(text) {
					if text[index] >= 0x40 && text[index] <= 0x7e {
						index++
						break
					}
					index++
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

func (animation *lsAnimation) statusLine() string {
	if animation.editing {
		return animation.palette.cyan("/") + animation.query + animation.palette.gray("  Enter 保留 · Esc 清空 · Ctrl+C 退出")
	}
	if animation.query != "" {
		return animation.palette.gray("筛选: " + animation.query + "  ·  / 继续输入  ·  Esc 清空  ·  q 退出")
	}
	return animation.palette.gray("/ 筛选  ·  q/Esc 退出")
}

func (animation *lsAnimation) render(static bool) {
	if animation.data == nil {
		return
	}
	if animation.activities == nil || time.Since(animation.activityAt) >= lsActivityReadEvery {
		animation.activities = readLSActivity(animation.aiHomeDir)
		animation.activityAt = time.Now()
	}
	rows := buildLSRows(animation.data, animation.query, animation.palette, true, animation.start, time.Now())
	if len(animation.frameIdx) != len(rows) {
		animation.frameIdx = make([]int, len(rows))
	}
	targets := make([]string, len(rows))
	for index, row := range rows {
		prefix := animation.prefixFor(row, index, static)
		targets[index] = toLSScreenLine(row.render(prefix), animation.maxWidth())
	}
	if animation.painted != nil && len(targets) == len(animation.painted) {
		for index := range targets {
			if animation.dominoes[index] == nil && targets[index] != animation.painted[index] && shouldLSAnimate(targets[index], animation.painted[index]) {
				animation.startDomino(index, targets[index])
			}
		}
	}
	if static {
		animation.dominoes = make(map[int]*lsDomino)
	}
	displayed := animation.renderDominoes(targets)
	status := ""
	if !static {
		status = toLSScreenLine(animation.statusLine(), animation.maxWidth())
	}
	displayed = append(displayed, status)
	if animation.painted != nil && sameLSLines(displayed, animation.painted) {
		animation.advanceDominoes()
		return
	}
	animation.writeFrame(displayed)
	animation.painted = displayed
	animation.advanceDominoes()
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

func (animation *lsAnimation) writeFrame(lines []string) {
	animation.writeMu.Lock()
	defer animation.writeMu.Unlock()
	write := func(value string) { _, _ = io.WriteString(animation.stdout, value) }
	write("\x1b[?2026h")
	defer write("\x1b[?2026l")
	if animation.painted == nil {
		write("\x1b[H\x1b[J")
		for _, line := range lines {
			write(line + "\n")
		}
		return
	}
	if len(lines) == len(animation.painted) && animation.rows > 0 {
		scrolledOff := 0
		if len(lines) > animation.rows-1 {
			scrolledOff = len(lines) - (animation.rows - 1)
		}
		touched := false
		for index := scrolledOff; index < len(lines); index++ {
			if lines[index] == animation.painted[index] {
				continue
			}
			write(fmt.Sprintf("\x1b[%d;1H%s\x1b[K", index-scrolledOff+1, lines[index]))
			touched = true
		}
		if touched {
			park := len(lines) - scrolledOff + 1
			if animation.rows > 0 && park > animation.rows {
				park = animation.rows
			}
			write(fmt.Sprintf("\x1b[%d;1H", park))
		}
		return
	}
	write("\x1b[H")
	for _, line := range lines {
		write(line + "\x1b[K\n")
	}
	if len(lines) < len(animation.painted) {
		write("\x1b[J")
	}
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

func (animation *lsAnimation) renderDominoes(targets []string) []string {
	displayed := append([]string(nil), targets...)
	for index, state := range animation.dominoes {
		if index >= len(targets) {
			delete(animation.dominoes, index)
			continue
		}
		if stripLSPrefix(state.target) != stripLSPrefix(targets[index]) {
			delete(animation.dominoes, index)
			animation.startDomino(index, targets[index])
			continue
		}
		state.target = targets[index]
		if state.frame < lsDominoSteps {
			displayed[index] = applyLSDomino(state.target, lsPrefixWidth+state.frame*state.step)
		}
	}
	return displayed
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

func sameLSLines(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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

func toLSScreenLine(value string, maxWidth int) string {
	single := strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
	if maxWidth <= 0 {
		return single
	}
	var builder strings.Builder
	width := 0
	for index := 0; index < len(single); {
		if single[index] == 0x1b {
			if end := lsEscapeEnd(single, index); end > index {
				builder.WriteString(single[index:end])
				index = end
				continue
			}
		}
		rune, size := utf8.DecodeRuneInString(single[index:])
		if size <= 0 {
			break
		}
		cell := lsRuneWidth(rune)
		if width+cell > maxWidth {
			builder.WriteString("\x1b[0m")
			break
		}
		builder.WriteString(single[index : index+size])
		width += cell
		index += size
	}
	return builder.String()
}

func lsVisibleWidth(value string) int {
	width := 0
	for index := 0; index < len(value); {
		if value[index] == 0x1b {
			if end := lsEscapeEnd(value, index); end > index {
				index = end
				continue
			}
		}
		rune, size := utf8.DecodeRuneInString(value[index:])
		if size <= 0 {
			break
		}
		width += lsRuneWidth(rune)
		index += size
	}
	return width
}

func lsEscapeEnd(value string, start int) int {
	if start+1 >= len(value) || value[start] != 0x1b || value[start+1] != '[' {
		return start
	}
	index := start + 2
	for index < len(value) {
		if value[index] >= 0x40 && value[index] <= 0x7e {
			return index + 1
		}
		index++
	}
	return len(value)
}

func lsRuneWidth(runeValue rune) int {
	code := int(runeValue)
	if code >= 0x1100 && (code <= 0x115f ||
		code == 0x2329 || code == 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6)) {
		return 2
	}
	return 1
}

func applyLSDomino(value string, startCol int) string {
	var builder strings.Builder
	column := 0
	glyph := 0
	for index := 0; index < len(value); {
		if value[index] == 0x1b {
			if end := lsEscapeEnd(value, index); end > index {
				builder.WriteString(value[index:end])
				index = end
				continue
			}
		}
		rune, size := utf8.DecodeRuneInString(value[index:])
		if size <= 0 {
			break
		}
		width := lsRuneWidth(rune)
		if glyph < len(lsDominoGlyphs) && column >= startCol {
			builder.WriteString(lsDominoGlyphs[glyph])
			glyph++
			if width == 2 {
				builder.WriteString(" ")
			}
			column += width
			index += size
			continue
		}
		builder.WriteString(value[index : index+size])
		column += width
		index += size
	}
	return builder.String()
}
