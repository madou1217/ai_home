package peer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/platform"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

// Target contains addressing metadata only. Listing never connects to a user's
// messaging socket or types into a terminal just to test availability.
type Target struct {
	ID string `json:"id"`
	RecordParty
	CWD       string `json:"cwd,omitempty"`
	Status    string `json:"status"`
	ConfigDir string `json:"-"`
}

func ListTargets(ctx context.Context, home, host string, getenv func(string) string) ([]Target, error) {
	out := []Target{}
	seen := map[string]bool{}
	for _, dir := range ListClaudeConfigDirs(host, home, getenv) {
		files, _ := os.ReadDir(filepath.Join(dir, "sessions"))
		for _, file := range files {
			pid, err := strconv.Atoi(strings.TrimSuffix(file.Name(), ".json"))
			if err != nil || pid <= 0 || !strings.HasSuffix(file.Name(), ".json") || !platform.ProcessAlive(pid) {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, "sessions", file.Name()))
			if err != nil {
				continue
			}
			var rec struct {
				PID       int    `json:"pid"`
				SessionID string `json:"sessionId"`
				Name      string `json:"name"`
				Socket    string `json:"messagingSocketPath"`
				CWD       string `json:"cwd"`
				Status    string `json:"status"`
			}
			if json.Unmarshal(raw, &rec) != nil || rec.PID != pid || rec.Socket == "" || rec.SessionID == "" {
				continue
			}
			info, err := os.Stat(rec.Socket)
			if err != nil || info.Mode()&os.ModeSocket == 0 {
				continue
			}
			id := "claude:" + strconv.Itoa(pid)
			if seen[id] {
				continue
			}
			seen[id] = true
			name := rec.Name
			if name == "" {
				name = rec.SessionID
			}
			out = append(out, Target{ID: id, RecordParty: RecordParty{Channel: "native", Provider: "claude", Name: name, Address: strconv.Itoa(pid), SessionID: rec.SessionID, Delivery: &DeliveryTarget{Socket: rec.Socket}}, CWD: rec.CWD, Status: rec.Status, ConfigDir: dir})
		}
	}
	for _, rec := range sessionactivity.ListPersistentRegistryEntries(home) {
		if rec.Unrecoverable != "" || rec.Socket == "" || rec.Session == "" || !IsSafeSessionName(rec.Session) || NormalizeRuntimeScope(rec.RuntimeScope) == "" {
			continue
		}
		probe, cancel := context.WithTimeout(ctx, ActivityProbeTimeout)
		err := exec.CommandContext(probe, "tmux", "-L", rec.Socket, "has-session", "-t", "="+rec.Session).Run()
		cancel()
		if err != nil {
			continue
		}
		id := fmt.Sprintf("session:%s:%s:%s", rec.Provider, rec.RuntimeScope, rec.Session)
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, Target{ID: id, RecordParty: RecordParty{Channel: "inject", Provider: rec.Provider, Name: rec.Session, Address: rec.Session, SessionID: rec.NativeSessionID, Delivery: &DeliveryTarget{CLIName: rec.Provider, RuntimeScope: rec.RuntimeScope, SessionName: rec.Session, Socket: rec.Socket}}, CWD: rec.Cwd, Status: "live"})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func FindTarget(targets []Target, wanted string) (Target, error) {
	wanted = strings.TrimSpace(wanted)
	if wanted == "" {
		return Target{}, ErrIdentityMismatch
	}
	for _, test := range []func(Target) bool{
		func(t Target) bool { return t.ID == wanted },
		func(t Target) bool { return t.Name == wanted },
		func(t Target) bool { return t.SessionID == wanted },
		func(t Target) bool { return t.Address == wanted },
		func(t Target) bool {
			return strings.HasPrefix(t.ID, wanted) || strings.HasPrefix(t.Name, wanted) || t.SessionID != "" && strings.HasPrefix(t.SessionID, wanted)
		},
	} {
		matches := []Target{}
		for _, t := range targets {
			if test(t) {
				matches = append(matches, t)
			}
		}
		if len(matches) == 1 {
			return matches[0], nil
		}
		if len(matches) > 1 {
			return Target{}, fmt.Errorf("目标不唯一，请使用完整 ID：%s", wanted)
		}
	}
	return Target{}, fmt.Errorf("会话不存在或已结束：%s", wanted)
}
