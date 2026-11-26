// Package clippicker provides a zero-dependency interactive terminal picker for clipboard items.
package clippicker

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

	"github.com/madou1217/ai_home/internal/runtime/termtext"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/runtime/clipboardio"
)

const (
	defaultLimit = 200
	maxLimit     = 200
)

// Row is a displayable clipboard entry in the picker list.
type Row struct {
	ID           string
	Index        int
	Kind         clipboard.Kind
	Preview      string
	LastSeenAtMs int64
	Pinned       bool
	Item         clipboard.Item
}

// Options configures a Run invocation.
type Options struct {
	Service     *clipboard.Service
	Writer      clipboardio.Writer
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
	Kind        clipboard.Kind
	Query       string
	Limit       int
	PrintStdout bool
	NoColor     bool
}

type pickerState struct {
	allRows       []Row
	filtered      []Row
	selected      int
	scroll        int
	query         string
	searching     bool
	confirmDelete bool
	toast         string
	noColor       bool
	kindFilter    clipboard.Kind
}

func newPickerState(rows []Row, initialQuery string, kind clipboard.Kind, noColor bool) *pickerState {
	s := &pickerState{
		allRows:    rows,
		query:      initialQuery,
		kindFilter: kind,
		noColor:    noColor,
	}
	s.applyFilter()
	return s
}

func (s *pickerState) setRows(rows []Row) {
	prevID := ""
	if cur := s.current(); cur != nil {
		prevID = cur.ID
	}
	s.allRows = rows
	s.applyFilter()
	if prevID != "" {
		for i, r := range s.filtered {
			if r.ID == prevID {
				s.selected = i
				return
			}
		}
	}
	s.clampSelection()
}

func (s *pickerState) applyFilter() {
	q := strings.ToLower(strings.TrimSpace(s.query))
	if q == "" {
		s.filtered = append(s.filtered[:0], s.allRows...)
		s.clampSelection()
		return
	}
	matched := make([]Row, 0, len(s.allRows))
	for _, r := range s.allRows {
		if rowMatches(r, q) {
			matched = append(matched, r)
		}
	}
	s.filtered = matched
	s.clampSelection()
}

func rowMatches(r Row, lowerQuery string) bool {
	if strings.Contains(strings.ToLower(r.Preview), lowerQuery) {
		return true
	}
	if strings.Contains(strings.ToLower(r.ID), lowerQuery) {
		return true
	}
	if strings.Contains(strings.ToLower(string(r.Kind)), lowerQuery) {
		return true
	}
	for _, f := range r.Item.Files {
		if strings.Contains(strings.ToLower(f), lowerQuery) {
			return true
		}
	}
	return false
}

func (s *pickerState) clampSelection() {
	if len(s.filtered) == 0 {
		s.selected = 0
		s.scroll = 0
		return
	}
	if s.selected < 0 {
		s.selected = 0
	}
	if s.selected >= len(s.filtered) {
		s.selected = len(s.filtered) - 1
	}
}

func (s *pickerState) move(delta int) {
	if len(s.filtered) == 0 {
		s.selected = 0
		return
	}
	s.selected += delta
	s.clampSelection()
}

func (s *pickerState) current() *Row {
	if s.selected < 0 || s.selected >= len(s.filtered) {
		return nil
	}
	return &s.filtered[s.selected]
}

// Run launches the interactive picker, or falls back to printing the latest match when stdin is not a TTY.
func Run(ctx context.Context, opts Options) error {
	if opts.Service == nil {
		return fmt.Errorf("clipboard service is required")
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	if opts.Stdin == nil {
		opts.Stdin = os.Stdin
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}

	rows, err := loadRows(ctx, opts.Service, opts.Kind, limit)
	if err != nil {
		return err
	}
	state := newPickerState(rows, opts.Query, opts.Kind, opts.NoColor)

	stdinFile, isFile := opts.Stdin.(*os.File)
	if !isFile || !term.IsTerminal(int(stdinFile.Fd())) {
		// Non-TTY mode (pipes, Vim system()): output latest matching item and exit 0.
		cur := state.current()
		if cur == nil {
			return nil
		}
		return emitItemOutput(ctx, opts.Service, cur.Item, opts.Stdout)
	}

	// Render the TUI to a TTY writer separate from piped stdout so shell command substitution
	// `$(aih clip pick --stdout)` captures only the final selected payload.
	tuiOut, closeTUI := resolveTUIWriter(opts.Stdout, opts.Stderr, opts.PrintStdout)
	defer closeTUI()

	fd := int(stdinFile.Fd())
	prevTermState, err := term.MakeRaw(fd)
	if err != nil {
		return err
	}

	var restoreOnce sync.Once
	restoreTerminal := func() {
		restoreOnce.Do(func() {
			_, _ = io.WriteString(tuiOut, "\x1b[?25h\x1b[?1049l")
			_ = term.Restore(fd, prevTermState)
		})
	}
	defer restoreTerminal()

	doneCh := make(chan struct{})
	defer close(doneCh)
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	go func() {
		select {
		case <-doneCh:
		case <-sigCh:
			restoreTerminal()
		case <-ctx.Done():
			restoreTerminal()
		}
	}()

	_, _ = io.WriteString(tuiOut, "\x1b[?1049h\x1b[?25l")

	buf := make([]byte, 32)
	for {
		width, height := terminalSize(tuiOut, fd)
		renderFrame(tuiOut, state, width, height, time.Now())

		n, readErr := stdinFile.Read(buf)
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return readErr
		}
		if n == 0 {
			return nil
		}

		action := handleInput(state, buf[:n])
		switch action {
		case actionQuit:
			return nil
		case actionSelectAndCopy:
			cur := state.current()
			if cur == nil {
				continue
			}
			restoreTerminal()
			if opts.Writer != nil && opts.Writer.Probe().Supported {
				_ = copyItemToClipboard(ctx, opts.Service, opts.Writer, cur.Item)
			}
			if opts.PrintStdout {
				return emitItemOutput(ctx, opts.Service, cur.Item, opts.Stdout)
			}
			return nil
		case actionPrintOnly:
			cur := state.current()
			if cur == nil {
				continue
			}
			restoreTerminal()
			return emitItemOutput(ctx, opts.Service, cur.Item, opts.Stdout)
		case actionTogglePin:
			cur := state.current()
			if cur == nil {
				continue
			}
			updated, pinErr := opts.Service.SetPinned(ctx, cur.ID, !cur.Pinned)
			if pinErr != nil {
				state.toast = "Pin failed: " + pinErr.Error()
			} else {
				if updated.Pinned {
					state.toast = fmt.Sprintf("Pinned #%d", cur.Index)
				} else {
					state.toast = fmt.Sprintf("Unpinned #%d", cur.Index)
				}
				if refreshed, refErr := loadRows(ctx, opts.Service, opts.Kind, limit); refErr == nil {
					state.setRows(refreshed)
				}
			}
		case actionConfirmDelete:
			cur := state.current()
			if cur == nil {
				state.confirmDelete = false
				continue
			}
			if delErr := opts.Service.Delete(ctx, cur.ID); delErr != nil {
				state.toast = "Delete failed: " + delErr.Error()
			} else {
				state.toast = fmt.Sprintf("Deleted #%d", cur.Index)
				if refreshed, refErr := loadRows(ctx, opts.Service, opts.Kind, limit); refErr == nil {
					state.setRows(refreshed)
				}
			}
			state.confirmDelete = false
		}
	}
}

type keyAction int

const (
	actionNone keyAction = iota
	actionQuit
	actionSelectAndCopy
	actionPrintOnly
	actionTogglePin
	actionConfirmDelete
)

func handleInput(s *pickerState, raw []byte) keyAction {
	if len(raw) == 0 {
		return actionNone
	}
	// Ctrl-C always exits cleanly.
	if raw[0] == 0x03 {
		return actionQuit
	}

	if s.confirmDelete {
		if raw[0] == 'y' || raw[0] == 'Y' {
			return actionConfirmDelete
		}
		s.confirmDelete = false
		s.toast = "Delete cancelled"
		return actionNone
	}

	if s.searching {
		return handleSearchInput(s, raw)
	}

	s.toast = ""
	key := parseKey(raw)
	switch key {
	case "up", "k":
		s.move(-1)
	case "down", "j":
		s.move(1)
	case "pgup":
		s.move(-10)
	case "pgdown":
		s.move(10)
	case "home", "g":
		s.selected = 0
		s.clampSelection()
	case "end", "G":
		if len(s.filtered) > 0 {
			s.selected = len(s.filtered) - 1
		}
	case "/":
		s.searching = true
	case "enter":
		if s.current() != nil {
			return actionSelectAndCopy
		}
	case "y":
		if s.current() != nil {
			return actionPrintOnly
		}
	case "p":
		if s.current() != nil {
			return actionTogglePin
		}
	case "d":
		if s.current() != nil {
			s.confirmDelete = true
		}
	case "q", "esc", "ctrl-c":
		return actionQuit
	}
	return actionNone
}

func handleSearchInput(s *pickerState, raw []byte) keyAction {
	key := parseKey(raw)
	switch key {
	case "ctrl-c":
		return actionQuit
	case "esc":
		s.searching = false
		return actionNone
	case "enter":
		s.searching = false
		return actionNone
	case "up":
		s.move(-1)
		return actionNone
	case "down":
		s.move(1)
		return actionNone
	}

	// Process raw UTF-8 / control bytes inside search input.
	for i := 0; i < len(raw); {
		b := raw[i]
		switch b {
		case 0x7f, 0x08: // Backspace
			runes := []rune(s.query)
			if len(runes) > 0 {
				s.query = string(runes[:len(runes)-1])
				s.applyFilter()
			}
			i++
		case 0x15: // Ctrl-U clears search query
			s.query = ""
			s.applyFilter()
			i++
		case 0x1b: // Esc sequence or bare Esc
			s.searching = false
			return actionNone
		default:
			if b < 0x20 {
				i++
				continue
			}
			r, size := utf8.DecodeRune(raw[i:])
			if r != utf8.RuneError || size > 1 {
				s.query += string(r)
				s.applyFilter()
			}
			i += size
		}
	}
	return actionNone
}

func parseKey(raw []byte) string {
	text := string(raw)
	switch text {
	case "\x1b[A", "\x1bOA":
		return "up"
	case "\x1b[B", "\x1bOB":
		return "down"
	case "\x1b[5~":
		return "pgup"
	case "\x1b[6~":
		return "pgdown"
	case "\x1b[H", "\x1bOH", "\x1b[1~":
		return "home"
	case "\x1b[F", "\x1bOF", "\x1b[4~":
		return "end"
	case "\x1b":
		return "esc"
	case "\r", "\n":
		return "enter"
	case "\x03":
		return "ctrl-c"
	}
	if len(raw) == 1 {
		return text
	}
	return ""
}

func loadRows(ctx context.Context, service *clipboard.Service, kind clipboard.Kind, limit int) ([]Row, error) {
	items, err := service.List(ctx, clipboard.ListFilter{
		Limit: limit,
		Kind:  kind,
	})
	if err != nil {
		return nil, err
	}
	rows := make([]Row, 0, len(items))
	for i, item := range items {
		rows = append(rows, Row{
			ID:           item.ID,
			Index:        i + 1,
			Kind:         item.Kind,
			Preview:      item.Preview,
			LastSeenAtMs: item.LastSeenAtMs,
			Pinned:       item.Pinned,
			Item:         item,
		})
	}
	return rows, nil
}

func resolveTUIWriter(stdout, stderr io.Writer, printStdout bool) (io.Writer, func()) {
	if !printStdout {
		if f, ok := stdout.(interface{ Fd() uintptr }); ok && term.IsTerminal(int(f.Fd())) {
			return termtext.WrapWriter(stdout), func() {}
		}
	}
	if f, ok := stderr.(interface{ Fd() uintptr }); ok && term.IsTerminal(int(f.Fd())) {
		return termtext.WrapWriter(stderr), func() {}
	}
	if tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0); err == nil {
		return termtext.WrapWriter(tty), func() { _ = tty.Close() }
	}
	if stderr != nil {
		return termtext.WrapWriter(stderr), func() {}
	}
	return termtext.WrapWriter(stdout), func() {}
}

func terminalSize(tuiOut io.Writer, stdinFD int) (int, int) {
	if f, ok := tuiOut.(interface{ Fd() uintptr }); ok {
		if w, h, err := term.GetSize(int(f.Fd())); err == nil && w > 0 && h > 0 {
			return w, h
		}
	}
	if w, h, err := term.GetSize(stdinFD); err == nil && w > 0 && h > 0 {
		return w, h
	}
	return 80, 24
}

func copyItemToClipboard(ctx context.Context, service *clipboard.Service, writer clipboardio.Writer, item clipboard.Item) error {
	fullItem, err := service.Get(ctx, item.ID)
	if err != nil {
		fullItem = item
	}
	content, err := service.ReadContent(ctx, fullItem)
	if err != nil {
		return err
	}
	switch fullItem.Kind {
	case clipboard.KindImage:
		return writer.WriteImage(ctx, content.Data, content.MIME)
	case clipboard.KindFile:
		return writer.WriteFiles(ctx, fullItem.Files)
	default:
		return writer.WriteText(ctx, string(content.Data))
	}
}

func emitItemOutput(ctx context.Context, service *clipboard.Service, item clipboard.Item, out io.Writer) error {
	fullItem, err := service.Get(ctx, item.ID)
	if err != nil {
		fullItem = item
	}
	content, err := service.ReadContent(ctx, fullItem)
	if err != nil {
		return err
	}
	switch fullItem.Kind {
	case clipboard.KindImage:
		_, err = io.WriteString(out, content.AbsoluteBlobPath)
		return err
	default:
		_, err = out.Write(content.Data)
		return err
	}
}
