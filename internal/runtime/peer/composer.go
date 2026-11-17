package peer

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

var composerFooter = regexp.MustCompile(`^\s*(?:\? for shortcuts|(?:enter/esc|enter|esc).*\? shortcuts|\d+% context left)`)

// The editable text may contain separator or footer-looking lines. Only the
// footer at the physical bottom of the pane can terminate the composer.
func composerEnd(lines []string) int {
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) < 2 || !composerFooter.MatchString(lines[len(lines)-1]) {
		return -1
	}
	end := len(lines) - 1
	if composerBoundary.MatchString(lines[end-1]) {
		return end - 1
	}
	// Codex keeps its model/permissions status on the penultimate pane row.
	if strings.Contains(lines[end-1], " · ") {
		return end - 1
	}
	return -1
}

var composerBoundary = regexp.MustCompile(`^\s*[─━═-]{3,}\s*$`)

var composerPrompt = regexp.MustCompile(`^\s*[›❯>](?: (.*))?$`)

// A quiet pane may still contain a draft. Dispatch must never submit that draft
// together with a notification, including when the background daemon retries.
func inspectComposer(ctx context.Context, runner TmuxCommandRunner, command, socket, session string) string {
	run := func(args ...string) (string, bool) {
		probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
		defer cancel()
		output, code, err := runner(probe, command, append([]string{"-u", "-L", socket}, args...))
		return output, err == nil && code == 0
	}
	cursor, ok := run("display-message", "-p", "-t", session, "#{cursor_y}")
	if !ok {
		sessions, available := run("list-sessions", "-F", "#{session_name}")
		if available {
			for _, name := range strings.Split(sessions, "\n") {
				if strings.TrimSpace(name) == session {
					return "unknown"
				}
			}
			return "gone"
		}
		return "unknown"
	}
	y, err := strconv.Atoi(strings.TrimSpace(cursor))
	if err != nil || y < 0 {
		return "unknown"
	}
	pane, ok := run("capture-pane", "-p", "-t", session)
	lines := strings.Split(pane, "\n")
	end := composerEnd(lines)
	if !ok || y >= len(lines) || end < 0 || y >= end {
		return "unknown"
	}
	for row := y; row >= 0; row-- {
		if composerBoundary.MatchString(lines[row]) {
			break
		}
		match := composerPrompt.FindStringSubmatch(lines[row])
		if match == nil {
			continue
		}
		for below := y + 1; below < end; below++ {
			if strings.TrimSpace(lines[below]) != "" {
				return "draft"
			}
		}
		text := strings.TrimSpace(strings.Join(append([]string{match[1]}, lines[row+1:y+1]...), "\n"))
		if text == "" || text == "Ask Codex to do anything" || text == "Type a message" || text == "Ask anything" {
			return "empty"
		}
		return "draft"
	}
	return "unknown"
}
