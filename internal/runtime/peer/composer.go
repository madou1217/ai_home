package peer

import (
	"context"
	"regexp"
	"strconv"
	"strings"
)

var composerPrompt = regexp.MustCompile(`^\s*[›❯>] (.*)$`)

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
		return "unknown"
	}
	y, err := strconv.Atoi(strings.TrimSpace(cursor))
	if err != nil || y < 0 {
		return "unknown"
	}
	pane, ok := run("capture-pane", "-p", "-t", session)
	lines := strings.Split(pane, "\n")
	if !ok || y >= len(lines) {
		return "unknown"
	}
	for row := y; row >= 0; row-- {
		match := composerPrompt.FindStringSubmatch(lines[row])
		if match == nil {
			continue
		}
		text := strings.TrimSpace(strings.Join(append([]string{match[1]}, lines[row+1:y+1]...), "\n"))
		if text == "" || text == "Ask Codex to do anything" || text == "Type a message" || text == "Ask anything" {
			return "empty"
		}
		return "draft"
	}
	return "unknown"
}
