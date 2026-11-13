package egress

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SessionLeaseAllocation 描述当前本地 CLI 会话认领到的独占出口车道结果。
type SessionLeaseAllocation struct {
	URL    string `json:"url"`
	Slot   int    `json:"slot"`
	Shared bool   `json:"shared"`
}

// SessionLeaseStatus 描述某账号会话槽位当前的租约持有状态（排障/WebUI 用）。
type SessionLeaseStatus struct {
	Slot  int  `json:"slot"`
	PID   int  `json:"pid"`
	Alive bool `json:"alive"`
}

type sessionLeaseFileDoc struct {
	PID int   `json:"pid"`
	At  int64 `json:"at"`
}

func sanitizeLeaseSegment(value string) string {
	trimmed := strings.TrimSpace(value)
	var b strings.Builder
	b.Grow(len(trimmed))
	for i := 0; i < len(trimmed); i++ {
		ch := trimmed[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ||
			ch == '_' || ch == '.' || ch == '-' {
			b.WriteByte(ch)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// SessionLeaseDir 返回账号对应的会话车道租约目录。
func SessionLeaseDir(aiHomeDir string, accountRef string) string {
	return filepath.Join(
		strings.TrimSpace(aiHomeDir),
		"run", "egress-pool", "session-leases",
		sanitizeLeaseSegment(accountRef),
	)
}

func readSessionLease(filePath string) (*sessionLeaseFileDoc, bool) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, false
	}
	var doc sessionLeaseFileDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, false
	}
	return &doc, true
}

func tryCreateSessionLease(filePath string, pid int, nowMS int64) bool {
	payload, err := json.Marshal(sessionLeaseFileDoc{PID: pid, At: nowMS})
	if err != nil {
		return false
	}
	file, err := os.OpenFile(filePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	_, writeErr := file.Write(payload)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(filePath)
		return false
	}
	return true
}

// AcquireSessionLane 为当前会话以 O_EXCL 原子抢占一条空闲会话车道；全满时按 pid 取模共享。
func AcquireSessionLane(
	aiHomeDir string,
	accountRef string,
	urls []string,
	pid int,
	pidAlive func(int) bool,
	nowMS int64,
) *SessionLeaseAllocation {
	filtered := make([]string, 0, len(urls))
	for _, u := range urls {
		if trimmed := strings.TrimSpace(u); trimmed != "" {
			filtered = append(filtered, trimmed)
		}
	}
	if len(filtered) == 0 {
		return nil
	}
	if pid <= 0 {
		pid = os.Getpid()
	}
	if pidAlive == nil {
		pidAlive = DefaultPIDAlive
	}
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}
	dir := SessionLeaseDir(aiHomeDir, accountRef)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slot := pid % len(filtered)
		return &SessionLeaseAllocation{URL: filtered[slot], Slot: slot, Shared: true}
	}
	for slot, laneURL := range filtered {
		filePath := filepath.Join(dir, fmt.Sprintf("lane-%d.json", slot))
		if tryCreateSessionLease(filePath, pid, nowMS) {
			return &SessionLeaseAllocation{URL: laneURL, Slot: slot, Shared: false}
		}
		if doc, ok := readSessionLease(filePath); ok {
			if doc.PID == pid {
				return &SessionLeaseAllocation{URL: laneURL, Slot: slot, Shared: false}
			}
			if pidAlive(doc.PID) {
				continue
			}
		}
		_ = os.Remove(filePath)
		if tryCreateSessionLease(filePath, pid, nowMS) {
			return &SessionLeaseAllocation{URL: laneURL, Slot: slot, Shared: false}
		}
	}
	slot := pid % len(filtered)
	return &SessionLeaseAllocation{URL: filtered[slot], Slot: slot, Shared: true}
}

// DescribeSessionLeases 返回指定账号各会话槽位当前的租约持有状况。
func DescribeSessionLeases(aiHomeDir string, accountRef string, count int, pidAlive func(int) bool) []SessionLeaseStatus {
	if count <= 0 {
		return nil
	}
	if pidAlive == nil {
		pidAlive = DefaultPIDAlive
	}
	dir := SessionLeaseDir(aiHomeDir, accountRef)
	out := make([]SessionLeaseStatus, count)
	for slot := 0; slot < count; slot++ {
		filePath := filepath.Join(dir, fmt.Sprintf("lane-%d.json", slot))
		doc, ok := readSessionLease(filePath)
		pid := 0
		alive := false
		if ok && doc != nil && doc.PID > 0 {
			pid = doc.PID
			alive = pidAlive(pid)
		}
		out[slot] = SessionLeaseStatus{Slot: slot, PID: pid, Alive: alive}
	}
	return out
}
