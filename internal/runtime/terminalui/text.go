// Package terminalui owns display-cell layout and physical terminal frames.
// Domain renderers provide text; they must not count bytes/runes as columns or
// depend on terminal autowrap when addressing rows in a later frame.
package terminalui

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/rivo/uniseg"
)

const Reset = "\x1b[0m"

var ErrNarrowViewport = errors.New("terminal is too narrow for a display cell")

type styleEvent struct {
	offset int
	code   string
}

// Cell is an indivisible grapheme with any SGR changes inside it. In particular,
// combining marks, variation selectors and ZWJ emoji are never split by a wrap
// or replaced piecemeal by an animation. A trailing SGR-only cell has width 0.
type Cell struct {
	Text  string
	Width int
}

// displayText permits only SGR from terminal control sequences. Account/model
// text is not allowed to move the cursor, ring bells or set terminal titles.
func displayText(value string) (string, []styleEvent) {
	var plain strings.Builder
	var styles []styleEvent
	for len(value) > 0 {
		if value[0] == '\x1b' {
			end := escapeEnd(value)
			code := value[:end]
			if isSGR(code) {
				styles = append(styles, styleEvent{plain.Len(), code})
			}
			value = value[end:]
			continue
		}
		r, size := utf8.DecodeRuneInString(value)
		value = value[size:]
		switch {
		case r == '\r' || r == '\n' || r == '\t':
			plain.WriteByte(' ')
		case unicode.IsControl(r):
			// Other C0/C1 controls have no display cells.
		default:
			plain.WriteRune(r)
		}
	}
	return plain.String(), styles
}

func escapeEnd(value string) int {
	if len(value) < 2 {
		return len(value)
	}
	switch value[1] {
	case '[':
		for i := 2; i < len(value); i++ {
			if value[i] >= 0x40 && value[i] <= 0x7e {
				return i + 1
			}
		}
	case ']', 'P', 'X', '^', '_':
		for i := 2; i < len(value); i++ {
			if value[i] == '\a' || value[i] == 0x9c {
				return i + 1
			}
			if value[i] == '\x1b' && i+1 < len(value) && value[i+1] == '\\' {
				return i + 2
			}
		}
	default:
		for i := 1; i < len(value); i++ {
			if value[i] >= 0x30 && value[i] <= 0x7e {
				return i + 1
			}
		}
	}
	return len(value)
}

func isSGR(code string) bool {
	if !strings.HasPrefix(code, "\x1b[") || !strings.HasSuffix(code, "m") {
		return false
	}
	for _, c := range code[2 : len(code)-1] {
		if (c < '0' || c > '9') && c != ';' && c != ':' {
			return false
		}
	}
	return true
}

func Plain(value string) string {
	plain, _ := displayText(value)
	return plain
}

func Width(value string) int { return uniseg.StringWidth(Plain(value)) }

func Cells(value string) []Cell {
	plain, styles := displayText(value)
	cells := make([]Cell, 0, len(plain))
	graphemes := uniseg.NewGraphemes(plain)
	next := 0
	for graphemes.Next() {
		start, end := graphemes.Positions()
		text := plain[start:end]
		if next < len(styles) && styles[next].offset < end {
			var b strings.Builder
			for next < len(styles) && styles[next].offset < end {
				event := styles[next]
				b.WriteString(plain[start:event.offset])
				b.WriteString(event.code)
				start = event.offset
				next++
			}
			b.WriteString(plain[start:end])
			text = b.String()
		}
		cells = append(cells, Cell{Text: text, Width: graphemes.Width()})
	}
	if next < len(styles) {
		var b strings.Builder
		for _, event := range styles[next:] {
			b.WriteString(event.code)
		}
		cells = append(cells, Cell{Text: b.String()})
	}
	return cells
}

// Line keeps the exact layout used by wrap; animations must not guess the
// indentation or remeasure the text after replacing its display cells.
type Line struct {
	Text   string
	Width  int
	Indent int
}

// Wrap retains every displayable character and returns independently styled
// physical lines. Continuation indentation is layout only, not domain content.
// Callers reserve the terminal's last column to avoid delayed-autowrap state.
func Wrap(value string, width, indent int) ([]Line, error) {
	cells := Cells(value)
	maxCell := 1
	for _, cell := range cells {
		maxCell = max(maxCell, cell.Width)
	}
	if width < maxCell {
		return nil, ErrNarrowViewport
	}
	indent = max(0, min(indent, width-maxCell))
	lines := make([]Line, 0, 1)
	style := ""
	for start := 0; start < len(cells); {
		padding := 0
		if len(lines) > 0 {
			padding = indent
		}
		column, end, boundary := padding, start, start
		for end < len(cells) && column+cells[end].Width <= width {
			column += cells[end].Width
			end++
			if strings.HasSuffix(cells[end-1].Text, " ") {
				boundary = end
			}
		}
		// Prefer whitespace to splitting a label/name. Very long tokens still
		// hard-wrap at grapheme boundaries. No input characters are discarded.
		if end < len(cells) && boundary > start {
			end = boundary
		}
		var line strings.Builder
		line.WriteString(strings.Repeat(" ", padding))
		line.WriteString(style)
		colored := style != ""
		used := padding
		for _, cell := range cells[start:end] {
			used += cell.Width
			line.WriteString(cell.Text)
			// Cells contain only validated SGR and printable text.
			for rest := cell.Text; ; {
				pos := strings.IndexByte(rest, '\x1b')
				if pos < 0 {
					break
				}
				rest = rest[pos:]
				end := escapeEnd(rest)
				code := rest[:end]
				colored = true
				if code == Reset || code == "\x1b[m" {
					style = ""
				} else {
					style += code
				}
				rest = rest[end:]
			}
		}
		if colored {
			line.WriteString(Reset)
		}
		lines = append(lines, Line{Text: line.String(), Width: used, Indent: padding})
		start = end
	}
	if len(lines) == 0 {
		return []Line{{}}, nil
	}
	return lines, nil
}

// ReplaceCells preserves styles and column positions while an animation passes
// over text. Each replacement consumes one whole grapheme, never half of one.
func ReplaceCells(value string, start int, glyphs []string) (string, int) {
	var b strings.Builder
	column, next := 0, 0
	for _, cell := range Cells(value) {
		if cell.Width > 0 && column >= start && next < len(glyphs) {
			_, styles := displayText(cell.Text)
			for _, event := range styles {
				b.WriteString(event.code)
			}
			b.WriteString(glyphs[next])
			b.WriteString(strings.Repeat(" ", max(0, cell.Width-Width(glyphs[next]))))
			next++
		} else {
			b.WriteString(cell.Text)
		}
		column += cell.Width
	}
	return b.String(), next
}
