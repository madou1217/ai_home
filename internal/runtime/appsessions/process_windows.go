//go:build windows

package appsessions

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

const processQueryTimeout = 15 * time.Second

func listProcesses(ctx context.Context) ([]Process, error) {
	queryCtx, cancel := context.WithTimeout(ctx, processQueryTimeout)
	defer cancel()
	command := exec.CommandContext(queryCtx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress")
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	return parseProcessJSON(output)
}

type processJSON struct {
	ProcessID    int    `json:"ProcessId"`
	CreationDate string `json:"CreationDate"`
	CommandLine  string `json:"CommandLine"`
}

func parseProcessJSON(raw []byte) ([]Process, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil, nil
	}
	var entries []processJSON
	if err := json.Unmarshal([]byte(trimmed), &entries); err != nil {
		var single processJSON
		if singleErr := json.Unmarshal([]byte(trimmed), &single); singleErr != nil {
			return nil, fmt.Errorf("parse process list: %w", err)
		}
		entries = []processJSON{single}
	}
	processes := make([]Process, 0, len(entries))
	for _, entry := range entries {
		if entry.ProcessID <= 0 || strings.TrimSpace(entry.CommandLine) == "" {
			continue
		}
		processes = append(processes, Process{
			PID:       entry.ProcessID,
			Command:   entry.CommandLine,
			StartedAt: parseWindowsDate(entry.CreationDate),
		})
	}
	return processes, nil
}

// parseWindowsDate accepts CIM's /Date(ms)/ and ISO-ish strings.
func parseWindowsDate(value string) time.Time {
	trimmed := strings.TrimSpace(value)
	if start := strings.Index(trimmed, "Date("); start >= 0 {
		digits := trimmed[start+5:]
		if end := strings.IndexAny(digits, ")/"); end >= 0 {
			digits = digits[:end]
		}
		if milliseconds, err := strconv.ParseInt(digits, 10, 64); err == nil {
			return time.UnixMilli(milliseconds)
		}
	}
	if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
		return parsed
	}
	return time.Time{}
}

func terminateProcesses(ctx context.Context, pids []int) ([]int, error) {
	var signalled []int
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if err := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T").Run(); err == nil {
			signalled = append(signalled, pid)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range signalled {
			if processAlive(pid) {
				alive = true
				break
			}
		}
		if !alive {
			break
		}
		select {
		case <-ctx.Done():
			return signalled, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	for _, pid := range signalled {
		if processAlive(pid) {
			_ = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
		}
	}
	return signalled, nil
}

func processAlive(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == 259 // STILL_ACTIVE
}
