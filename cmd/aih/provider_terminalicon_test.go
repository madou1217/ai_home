package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseTerminalIconOptions 与 Node 同旗标、未知参数原样报错。
func TestParseTerminalIconOptions(t *testing.T) {
	options, unknown := parseTerminalIconOptions([]string{
		"--all", "--json", "--install-iterm2", "--help",
	})
	if !options.all || !options.json || !options.installIterm2 || !options.help {
		t.Fatalf("options = %#v", options)
	}
	if len(unknown) != 0 {
		t.Fatalf("unknown = %v", unknown)
	}
	_, unknown = parseTerminalIconOptions([]string{"--nope"})
	if len(unknown) != 1 || unknown[0] != "--nope" {
		t.Fatalf("unknown = %v", unknown)
	}
}

// TestDetectTerminalIconTarget Warp 优先于平台默认（写 settings.toml 而不是 profile）。
func TestDetectTerminalIconTarget(t *testing.T) {
	if got := detectTerminalIconTarget(map[string]string{"TERM_PROGRAM": "WarpTerminal"}, "darwin"); got != "warp" {
		t.Fatalf("warp target = %q", got)
	}
	if got := detectTerminalIconTarget(map[string]string{}, "darwin"); got != "iterm2" {
		t.Fatalf("darwin target = %q", got)
	}
	if got := detectTerminalIconTarget(map[string]string{}, "linux"); got != "linux" {
		t.Fatalf("linux target = %q", got)
	}
}

// TestRunTerminalIconMaterializesIcons 默认形态只写 AIH 数据目录，不碰宿主配置。
func TestRunTerminalIconMaterializesIcons(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	environment := map[string]string{"AIH_HOME_DIR": aiHome}
	runtime := commandRuntime{
		lookupEnv: func(name string) (string, bool) {
			value, ok := environment[name]
			return value, ok
		},
		userHomeDir: func() (string, error) { return hostHome, nil },
		stdout:      io.Discard,
	}
	if err := runProviderTerminalIcon(
		context.Background(),
		"codebuddycn",
		[]string{"--json"},
		runtime,
	); err != nil {
		t.Fatalf("run: %v", err)
	}
	iconPath := filepath.Join(aiHome, "run", "terminal-icons", "codebuddycn.png")
	info, err := os.Stat(iconPath)
	if err != nil || info.Size() == 0 {
		t.Fatalf("icon = %v, %v", info, err)
	}
	entries, err := os.ReadDir(hostHome)
	if err != nil {
		t.Fatalf("read host: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("默认形态不应写宿主目录: %v", entries)
	}
}

// TestRunTerminalIconUnknownProvider 未知 Provider 报错而不是装错图标。
func TestRunTerminalIconUnknownProvider(t *testing.T) {
	runtime := commandRuntime{
		lookupEnv:   func(name string) (string, bool) { return "", false },
		userHomeDir: func() (string, error) { return t.TempDir(), nil },
		stdout:      io.Discard,
	}
	err := runProviderTerminalIcon(context.Background(), "nope", nil, runtime)
	if err == nil || !strings.Contains(err.Error(), "Unknown provider") {
		t.Fatalf("err = %v", err)
	}
}
