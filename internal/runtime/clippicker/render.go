package clippicker

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"time"
)

// renderFrame renders the entire picker UI into a single buffer and writes it once
// starting at home (\x1b[H) with per-line clear (\x1b[K) and trailing clear (\x1b[J)
// to avoid flicker. When NO_COLOR is set, no ANSI SGR color sequences are emitted.
func renderFrame(out io.Writer, s *pickerState, width, height int, now time.Time) {
	if width < 32 {
		width = 32
	}
	if height < 8 {
		height = 8
	}

	var buf bytes.Buffer
	buf.Grow(width * height)
	buf.WriteString("\x1b[H")

	writeLine := func(line string, selected bool, dim bool) {
		clipped := truncateColumns(line, width)
		if !s.noColor {
			switch {
			case selected:
				buf.WriteString("\x1b[7m")
			case dim:
				buf.WriteString("\x1b[2m")
			}
		}
		buf.WriteString(clipped)
		if !s.noColor && (selected || dim) {
			buf.WriteString("\x1b[0m")
		}
		buf.WriteString("\x1b[K\r\n")
	}

	// Line 1: Header + key legend.
	header := fmt.Sprintf("AIH Clipboard (%d/%d)  j/k:move  /:search  Enter:copy  y:print  p:pin  d:del  q:quit", len(s.filtered), len(s.allRows))
	if s.kindFilter != "" {
		header = fmt.Sprintf("AIH Clipboard [%s] (%d/%d)  j/k:move  /:search  Enter:copy  y:print  p:pin  d:del  q:quit", s.kindFilter, len(s.filtered), len(s.allRows))
	}
	writeLine(header, false, false)

	// Line 2: Search bar.
	var searchLine string
	if s.searching {
		searchLine = fmt.Sprintf("/ %s_  (Esc/Enter: done)", s.query)
	} else if s.query != "" {
		searchLine = fmt.Sprintf("Filter: %s  (press / to edit)", s.query)
	} else {
		searchLine = "Search: press / to filter previews"
	}
	writeLine(searchLine, false, !s.searching && s.query == "")

	// Line 3: ASCII divider.
	writeLine(strings.Repeat("-", width), false, true)

	// Reserve 3 header lines + 2 footer lines (divider + status/confirm).
	listHeight := height - 5
	if listHeight < 1 {
		listHeight = 1
	}

	// Keep selected row visible within the scrolling viewport.
	if s.selected < s.scroll {
		s.scroll = s.selected
	}
	if s.selected >= s.scroll+listHeight {
		s.scroll = s.selected - listHeight + 1
	}
	if s.scroll < 0 {
		s.scroll = 0
	}

	if len(s.filtered) == 0 {
		writeLine("  (no matching clipboard items)", false, true)
		for i := 1; i < listHeight; i++ {
			buf.WriteString("\x1b[K\r\n")
		}
	} else {
		end := s.scroll + listHeight
		if end > len(s.filtered) {
			end = len(s.filtered)
		}
		for idx := s.scroll; idx < end; idx++ {
			row := s.filtered[idx]
			selected := idx == s.selected
			cursor := "  "
			if selected {
				cursor = "> "
			}
			pinMark := " "
			if row.Pinned {
				pinMark = "*"
			}
			shortID := row.ID
			if len(shortID) > 8 {
				shortID = shortID[:8]
			}
			when := formatShortAge(now, row.LastSeenAtMs)
			preview := sanitizeSingleLine(row.Preview)
			line := fmt.Sprintf("%s#%-3d %s [%-5s] %-8s %-7s %s", cursor, row.Index, pinMark, row.Kind, shortID, when, preview)
			writeLine(line, selected, false)
		}
		for rendered := end - s.scroll; rendered < listHeight; rendered++ {
			buf.WriteString("\x1b[K\r\n")
		}
	}

	// Footer divider + status / delete confirm line.
	writeLine(strings.Repeat("-", width), false, true)
	footer := ""
	switch {
	case s.confirmDelete && s.current() != nil:
		cur := s.current()
		footer = fmt.Sprintf("Delete #%d (%s)? [y/N]", cur.Index, truncateColumns(sanitizeSingleLine(cur.Preview), 40))
	case s.toast != "":
		footer = s.toast
	case s.current() != nil:
		cur := s.current()
		footer = fmt.Sprintf("Selected #%d %s (%s)", cur.Index, cur.ID, cur.Kind)
	default:
		footer = "Empty"
	}
	clippedFooter := truncateColumns(footer, width)
	if !s.noColor && s.confirmDelete {
		buf.WriteString("\x1b[7m")
	}
	buf.WriteString(clippedFooter)
	if !s.noColor && s.confirmDelete {
		buf.WriteString("\x1b[0m")
	}
	buf.WriteString("\x1b[K\x1b[J")

	_, _ = out.Write(buf.Bytes())
}

func sanitizeSingleLine(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func truncateColumns(s string, maxCols int) string {
	if maxCols <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= maxCols {
		return s
	}
	if maxCols <= 3 {
		return string(runes[:maxCols])
	}
	return string(runes[:maxCols-3]) + "..."
}

func formatShortAge(now time.Time, tsMs int64) string {
	if tsMs <= 0 {
		return "-"
	}
	delta := now.Sub(time.UnixMilli(tsMs))
	if delta < 0 {
		delta = 0
	}
	switch {
	case delta < time.Minute:
		return fmt.Sprintf("%ds", int(delta.Seconds()))
	case delta < time.Hour:
		return fmt.Sprintf("%dm", int(delta.Minutes()))
	case delta < 24*time.Hour:
		return fmt.Sprintf("%dh", int(delta.Hours()))
	default:
		return fmt.Sprintf("%dd", int(delta.Hours()/24))
	}
}
