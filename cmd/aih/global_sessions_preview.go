package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// globalSessionJSONRow 在 aih ss 行上附加卡片实时预览。匿名嵌入保证原有
// JSON 字段完全不变，只在 --preview 时多出 Preview/PreviewSource。
type globalSessionJSONRow struct {
	persistent.SessionRow
	Preview       []sessionPreviewEntry `json:"Preview,omitempty"`
	PreviewSource string                `json:"PreviewSource,omitempty"`
}

const (
	sessionPreviewEntries = 10
	screenPreviewLines    = 12
	tmuxCaptureTimeout    = 1500 * time.Millisecond
)

func buildGlobalSessionJSONRows(
	ctx context.Context,
	runtime commandRuntime,
	rows []persistent.SessionRow,
	withPreview bool,
) []globalSessionJSONRow {
	result := make([]globalSessionJSONRow, 0, len(rows))
	if !withPreview {
		for _, row := range rows {
			result = append(result, globalSessionJSONRow{SessionRow: row})
		}
		return result
	}

	options, available := previewReadOptions(runtime)
	tmux := findTmuxCommand()
	for _, row := range rows {
		item := globalSessionJSONRow{SessionRow: row}
		// tmux 行展示真实终端画面；原生 CLI（Warp 等持有 PTY）无法读取屏幕，
		// 退化为实时 transcript 内容，避免伪造画面。
		if socket := strings.TrimSpace(row.Socket); socket != "" && !row.PaneDead {
			if entries := captureTmuxPreview(ctx, tmux, socket, row.Name, screenPreviewLines); len(entries) > 0 {
				item.Preview = entries
				item.PreviewSource = "tmux"
			}
		}
		if len(item.Preview) == 0 && available && strings.TrimSpace(row.NativeID) != "" {
			entries := transcriptEntriesForSession(ctx, options, row.Provider, row.NativeID, sessionPreviewEntries)
			if len(entries) > 0 {
				item.Preview = entries
				item.PreviewSource = "transcript"
			}
		}
		result = append(result, item)
	}
	return result
}

func previewReadOptions(runtime commandRuntime) (sessionread.Options, bool) {
	store, err := globalSessionStore(runtime)
	if err != nil || strings.TrimSpace(store.AIHomeDir) == "" {
		return sessionread.Options{}, false
	}
	hostHome := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHome == "" {
		hostHome, _ = runtime.userHomeDir()
	}
	return sessionread.Options{AIHomeDir: store.AIHomeDir, HostHomeDir: hostHome}, true
}

func captureTmuxPreview(
	ctx context.Context,
	tmux, socket, name string,
	maxLines int,
) []sessionPreviewEntry {
	if tmux == "" || socket == "" || name == "" || maxLines <= 0 {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, tmuxCaptureTimeout)
	defer cancel()
	output, err := exec.CommandContext(probeCtx, tmux, "-u", "-L", socket, "capture-pane", "-p", "-t", name).Output()
	if err != nil {
		return nil
	}
	raw := strings.Split(strings.ReplaceAll(string(output), "\r", ""), "\n")
	for len(raw) > 0 && strings.TrimSpace(raw[len(raw)-1]) == "" {
		raw = raw[:len(raw)-1]
	}
	start := len(raw) - maxLines
	if start < 0 {
		start = 0
	}
	entries := make([]sessionPreviewEntry, 0, len(raw)-start)
	for _, line := range raw[start:] {
		line = strings.TrimRight(line, " \t")
		if strings.TrimSpace(line) == "" {
			continue
		}
		entries = append(entries, sessionPreviewEntry{
			Kind: "screen",
			Role: "终端",
			Text: compactScreenLine(line),
		})
	}
	return entries
}

func compactScreenLine(value string) string {
	runes := []rune(value)
	if len(runes) > previewTextLimit*2 {
		return string(runes[:previewTextLimit*2]) + "…"
	}
	return value
}

func findTmuxCommand() string {
	if path, err := exec.LookPath("tmux"); err == nil {
		return path
	}
	for _, candidate := range []string{
		"/opt/homebrew/bin/tmux",
		"/usr/local/bin/tmux",
		"/usr/bin/tmux",
	} {
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			if absolute, absErr := filepath.Abs(candidate); absErr == nil {
				return absolute
			}
			return candidate
		}
	}
	return ""
}
