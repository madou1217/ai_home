package peer

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// This is an admission observation at send time, not a read receipt. Bound it
// to the exact registered socket/session and append cursor. The full AIH ID is
// retained on the native envelope so short preview collisions cannot ACK mail.
type nativeReceiptProbe struct {
	path      string
	offset    int64
	marker    string
	session   string
	configDir string
}

func newNativeReceiptProbe(req NativeSendRequest, opts DeliveryOptions) *nativeReceiptProbe {
	probe := &nativeReceiptProbe{session: req.SessionID, marker: "[aih-peer #" + req.MessageID + " "}
	if !recordIDPattern.MatchString(req.MessageID) || !sessionUUIDPattern.MatchString(req.SessionID) {
		return probe
	}
	dirs := opts.ClaudeConfigDirs
	if len(dirs) == 0 {
		dirs = ListClaudeConfigDirs(opts.HostHomeDir, opts.AIHomeDir, opts.Getenv)
	}
	for _, dir := range dirs {
		raw, err := os.ReadFile(filepath.Join(dir, "sessions", strconv.Itoa(req.PID)+".json"))
		if err != nil {
			continue
		}
		var reg struct {
			PID       int    `json:"pid"`
			SessionID string `json:"sessionId"`
			Socket    string `json:"messagingSocketPath"`
		}
		if json.Unmarshal(raw, &reg) != nil || reg.PID != req.PID || reg.SessionID != req.SessionID || reg.Socket != req.SocketPath {
			continue
		}
		probe.configDir = dir
		if probe.discover() {
			if info, err := os.Stat(probe.path); err == nil {
				probe.offset = info.Size()
			}
		}
		break
	}
	return probe
}

func (probe *nativeReceiptProbe) discover() bool {
	if probe.configDir == "" {
		return false
	}
	matches, _ := filepath.Glob(filepath.Join(probe.configDir, "projects", "*", probe.session+".jsonl"))
	if len(matches) != 1 {
		return false
	}
	info, err := os.Lstat(matches[0])
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	probe.path = matches[0]
	return true
}

// Cursor advances only across complete lines. Per-observation I/O is capped;
// inability to observe leaves sent/unknown and must never authorize retransmit.
func (probe *nativeReceiptProbe) status(ctx context.Context) string {
	if probe.path == "" && !probe.discover() {
		return "sent"
	}
	f, err := os.Open(probe.path)
	if err != nil {
		return "sent"
	}
	defer f.Close()
	if _, err = f.Seek(probe.offset, io.SeekStart); err != nil {
		return "sent"
	}
	reader := bufio.NewReaderSize(io.LimitReader(f, 2*1024*1024), 64*1024)
	status := "sent"
	consumed := 0
	for consumed < 2*1024*1024 && ctx.Err() == nil {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			break
		}
		consumed += len(line)
		probe.offset += int64(len(line))
		var rec struct {
			Type    string `json:"type"`
			Session string `json:"sessionId"`
			Content string `json:"content"`
			Origin  struct {
				Kind string `json:"kind"`
				Body string `json:"body"`
				PID  int    `json:"verifiedPeerPid"`
			} `json:"origin"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Session != probe.session {
			continue
		}
		if rec.Type == "user" && rec.Origin.Kind == "peer" && rec.Origin.PID == os.Getpid() && strings.Contains(rec.Origin.Body, probe.marker) {
			return "accepted"
		}
		// Held previews can omit the full marker. Never guess using the 8-digit ID.
		if rec.Type == "system" && strings.HasPrefix(rec.Content, "Held peer message") && strings.Contains(rec.Content, probe.marker) {
			status = "held"
		}
	}
	return status
}

func (probe *nativeReceiptProbe) wait(ctx context.Context) string {
	if probe.configDir == "" {
		return "sent"
	}
	observation, cancel := context.WithTimeout(ctx, 350*time.Millisecond)
	defer cancel()
	for {
		status := probe.status(observation)
		if status != "sent" || observation.Err() != nil {
			return status
		}
		timer := time.NewTimer(25 * time.Millisecond)
		select {
		case <-observation.Done():
			timer.Stop()
			return "sent"
		case <-timer.C:
		}
	}
}
