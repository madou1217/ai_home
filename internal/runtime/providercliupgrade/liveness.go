package providercliupgrade

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// RequiredQuiescentTicks 要求连续两次观测静默才允许就地升级。
const RequiredQuiescentTicks int64 = 2

// QuiescenceStatus 描述单个 provider 当前是否处于忙碌状态及依据证据。
type QuiescenceStatus struct {
	Busy       bool
	Evidence   []string
	ObservedAt int64
}

// IsQuiescentEnough 判断连续静默拍数是否达到门槛。
func IsQuiescentEnough(consecutiveQuiescentTicks int64) bool {
	return consecutiveQuiescentTicks >= RequiredQuiescentTicks
}

// CheckProviderQuiescence 通过 run/codex-app-server 与 run/persistent-sessions 判定 provider 是否在跑。
func CheckProviderQuiescence(
	provider string,
	aiHomeDir string,
	goos string,
	nowMs int64,
	hasRunSession func(socket string, multiplexer string) bool,
) QuiescenceStatus {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if normalized == "" {
		return QuiescenceStatus{Busy: true, Evidence: []string{"provider_unknown"}, ObservedAt: nowMs}
	}
	if goos == "" {
		goos = runtime.GOOS
	}
	if hasRunSession == nil {
		hasRunSession = defaultHasRunSession
	}

	var evidence []string
	if normalized == "codex" {
		evidence = append(evidence, collectCodexAppServerEvidence(aiHomeDir, goos, hasRunSession)...)
	}
	evidence = append(evidence, collectPersistentSessionEvidence(normalized, aiHomeDir)...)
	if evidence == nil {
		evidence = []string{}
	}
	return QuiescenceStatus{
		Busy:       len(evidence) > 0,
		Evidence:   evidence,
		ObservedAt: nowMs,
	}
}

func collectPersistentSessionEvidence(provider string, aiHomeDir string) []string {
	dir := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "persistent-sessions")
	names := listJSONFileNames(dir)
	prefix := "aih-" + provider + "-"
	var evidence []string
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			evidence = append(evidence, "session:"+strings.TrimSuffix(name, ".json"))
		}
	}
	return evidence
}

func collectCodexAppServerEvidence(
	aiHomeDir string,
	goos string,
	hasRunSession func(socket string, multiplexer string) bool,
) []string {
	dir := filepath.Join(strings.TrimSpace(aiHomeDir), "run", "codex-app-server")
	names := listJSONFileNames(dir)
	var evidence []string
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
			continue
		}
		if isAppServerStateAlive(doc, goos, hasRunSession) {
			evidence = append(evidence, "app_server:"+strings.TrimSuffix(name, ".json"))
		}
	}
	return evidence
}

func isAppServerStateAlive(state map[string]any, goos string, hasRunSession func(string, string) bool) bool {
	if rawPID, exists := state["pid"]; exists && rawPID != nil {
		pid := int(asInt64(rawPID))
		return isPIDAlive(pid)
	}
	socket := asTrimmedText(state["socket"])
	if socket == "" || isWindowsOS(goos) {
		return true
	}
	multiplexer := asTrimmedText(state["multiplexer"])
	if multiplexer == "" {
		multiplexer = "tmux"
	}
	return hasRunSession(socket, multiplexer)
}

func isPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}

func defaultHasRunSession(socket string, multiplexer string) bool {
	mux := strings.ToLower(strings.TrimSpace(multiplexer))
	if mux == "" {
		mux = "tmux"
	}
	if mux != "tmux" || strings.TrimSpace(socket) == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tmux", "-S", socket, "list-sessions")
	return cmd.Run() == nil
}

func listJSONFileNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			out = append(out, entry.Name())
		}
	}
	return out
}
