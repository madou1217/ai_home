package peer

import (
	"context"
	"regexp"
	"strings"
)

const tmuxSubmitPaneFormat = "#{pane_id}|#{session_name}|#{pane_key_mode}|#{pane_in_mode}|#{pane_input_off}|#{pane_synchronized}"

var tmuxPaneIDPattern = regexp.MustCompile(`^%[0-9]+$`)

// tmuxSubmitPlan belongs to one probed pane and one injection attempt.
// It never grants permission to clear input or try a second submit encoding.
type tmuxSubmitPlan struct {
	paneID      string
	sessionName string
}

func readTmuxSubmitValue(ctx context.Context, runner TmuxCommandRunner, command, socket string, args ...string) (string, bool) {
	probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
	defer cancel()
	output, code, err := runner(probe, command, append([]string{"-u", "-L", socket}, args...))
	return strings.TrimSpace(output), err == nil && code == 0
}

func readTmuxSubmitPane(ctx context.Context, runner TmuxCommandRunner, command, socket, target, sessionName string) (string, bool) {
	output, ok := readTmuxSubmitValue(ctx, runner, command, socket,
		"display-message", "-p", "-t", target, tmuxSubmitPaneFormat)
	if !ok {
		return "", false
	}
	fields := strings.Split(output, "|")
	if len(fields) != 6 || !tmuxPaneIDPattern.MatchString(fields[0]) ||
		fields[1] != sessionName || fields[2] != "Ext 2" ||
		fields[3] != "0" || fields[4] != "0" || fields[5] != "0" {
		return "", false
	}
	return fields[0], true
}

// resolveTmuxSubmitPlan only reads capabilities. Unknown Codex modes fail before
// any literal text is sent; a server-wide option alone does not prove pane mode.
func resolveTmuxSubmitPlan(ctx context.Context, runner TmuxCommandRunner, command, socket, sessionName string) (tmuxSubmitPlan, bool) {
	paneID, ok := readTmuxSubmitPane(ctx, runner, command, socket, sessionName, sessionName)
	if !ok {
		return tmuxSubmitPlan{}, false
	}
	extended, ok := readTmuxSubmitValue(ctx, runner, command, socket, "show-options", "-s", "-v", "extended-keys")
	if !ok || extended != "on" {
		return tmuxSubmitPlan{}, false
	}
	format, ok := readTmuxSubmitValue(ctx, runner, command, socket, "show-options", "-s", "-v", "extended-keys-format")
	if !ok || format != "csi-u" {
		return tmuxSubmitPlan{}, false
	}
	return tmuxSubmitPlan{paneID: paneID, sessionName: sessionName}, true
}

// recheck reads the captured pane, never the session's mutable active pane.
func (plan tmuxSubmitPlan) recheck(ctx context.Context, runner TmuxCommandRunner, command, socket string) bool {
	if !tmuxPaneIDPattern.MatchString(plan.paneID) {
		return false
	}
	paneID, ok := readTmuxSubmitPane(ctx, runner, command, socket, plan.paneID, plan.sessionName)
	return ok && paneID == plan.paneID
}

func (plan tmuxSubmitPlan) submitArgs(socket string) []string {
	return []string{"-u", "-L", socket, "send-keys", "-H", "-t", plan.paneID, "1b", "5b", "31", "33", "75"}
}
