package sessionactivity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// TurnState 表示探测策略产出的回合判定状态。
type TurnState int

const (
	TurnUnknown TurnState = iota
	TurnActive
	TurnIdle
)

const (
	AuthorityTurn     = "turn"
	AuthorityPositive = "positive"
	AuthorityNone     = "none"

	maxClineSessionDirs = 400
	kiroTailBytes       = 16 * 1024
)

// TurnSignal 描述一个探针观测到的回合状态。
type TurnSignal struct {
	State          TurnState
	Authority      string
	Decisive       bool
	LastActivityAt int64
	Source         string
}

// ProbeContext 为单个 harness 探针提供本轮共享状态与缓存。
type ProbeContext struct {
	HarnessID          string
	AccountRef         string
	Sessions           []TmuxSession
	NowMS              int64
	TurnActiveWindowMS int64
	TurnMode           string
	AIHomeDir          string
	HostHomeDir        string
	Cache              map[string]any
	RegistryEntries    []RegistryEntry
	ProcessAlive       func(pid int) (alive bool, known bool)
}

// HarnessProbe 定义按 harness 粒度观测原生回合信号的策略接口。
type HarnessProbe struct {
	ID       string
	Label    string
	Priority int
	Claims   func(harnessID string) bool
	Probe    func(ctx *ProbeContext) *TurnSignal
}

// BuiltinHarnessProbes 返回内建探针清单（按 Priority 降序、ID 升序）。
func BuiltinHarnessProbes() []HarnessProbe {
	probes := []HarnessProbe{
		clineSessionStoreProbe(),
		kiroSessionStoreProbe(),
		tmuxPaneProbe(),
	}
	sort.Slice(probes, func(i, j int) bool {
		if probes[i].Priority != probes[j].Priority {
			return probes[i].Priority > probes[j].Priority
		}
		return probes[i].ID < probes[j].ID
	})
	return probes
}

// ProbesForHarness 从探针集合中选出认领指定 harnessID 的策略列表。
func ProbesForHarness(probes []HarnessProbe, harnessID string) []HarnessProbe {
	id := strings.ToLower(strings.TrimSpace(harnessID))
	var matched []HarnessProbe
	for _, p := range probes {
		if p.Claims != nil && p.Claims(id) {
			matched = append(matched, p)
		}
	}
	return matched
}

// CombineTurnSignals 组合同一账号在多个探针下收集到的信号：
// decisive 结束 > 有活动 (activeAt >= idleAt) > 权威空闲 > 不动。
type CombinedTurnDecision struct {
	Action string // "active" | "idle" | "none"
	Source string
}

// CombineTurnSignals 执行与 Node account-session-activity 完全同口径的信号融合。
func CombineTurnSignals(signals []TurnSignal) CombinedTurnDecision {
	if len(signals) == 0 {
		return CombinedTurnDecision{Action: "none"}
	}
	for _, sig := range signals {
		if sig.State == TurnIdle && sig.Decisive {
			return CombinedTurnDecision{Action: "idle", Source: sig.Source}
		}
	}
	var (
		hasActive            bool
		maxActiveAt          int64
		bestActiveSource     string
		hasAuthIdle          bool
		maxIdleAt            int64
		bestIdleSource       string
	)
	for _, sig := range signals {
		switch sig.State {
		case TurnActive:
			if !hasActive || sig.LastActivityAt > maxActiveAt {
				maxActiveAt = sig.LastActivityAt
				bestActiveSource = sig.Source
			}
			hasActive = true
		case TurnIdle:
			if strings.ToLower(strings.TrimSpace(sig.Authority)) == AuthorityTurn {
				if !hasAuthIdle || sig.LastActivityAt > maxIdleAt {
					maxIdleAt = sig.LastActivityAt
					bestIdleSource = sig.Source
				}
				hasAuthIdle = true
			}
		}
	}
	if hasActive && maxActiveAt >= maxIdleAt {
		return CombinedTurnDecision{Action: "active", Source: bestActiveSource}
	}
	if hasAuthIdle {
		return CombinedTurnDecision{Action: "idle", Source: bestIdleSource}
	}
	return CombinedTurnDecision{Action: "none"}
}

func tmuxPaneProbe() HarnessProbe {
	return HarnessProbe{
		ID:       "tmux-pane",
		Label:    "持久终端 pane 活动",
		Priority: 0,
		Claims:   func(string) bool { return true },
		Probe: func(ctx *ProbeContext) *TurnSignal {
			if ctx == nil || len(ctx.Sessions) == 0 {
				return nil
			}
			var maxAct int64
			for _, s := range ctx.Sessions {
				if s.LastActivityAtMS > maxAct {
					maxAct = s.LastActivityAtMS
				}
			}
			if maxAct <= 0 {
				return nil
			}
			active := ctx.NowMS-maxAct <= ctx.TurnActiveWindowMS
			authority := AuthorityTurn
			if strings.ToLower(strings.TrimSpace(ctx.TurnMode)) == "hook" {
				authority = AuthorityPositive
			}
			state := TurnUnknown
			if active {
				state = TurnActive
			} else if authority == AuthorityTurn {
				state = TurnIdle
			}
			if state == TurnUnknown {
				return nil
			}
			return &TurnSignal{
				State:          state,
				Authority:      authority,
				Decisive:       false,
				LastActivityAt: maxAct,
				Source:         "tmux-pane",
			}
		},
	}
}

type clineSessionRecord struct {
	SessionID       string
	Cwd             string
	PID             int
	Status          string
	StartedAtMS     int64
	EndedAtMS       int64
	MessagesMtimeMS int64
}

func clineSessionStoreProbe() HarnessProbe {
	return HarnessProbe{
		ID:       "cline-session-store",
		Label:    "Cline 会话清单（started_at / ended_at / status）",
		Priority: 20,
		Claims:   func(harnessID string) bool { return harnessID == "cline" },
		Probe: func(ctx *ProbeContext) *TurnSignal {
			if ctx == nil || strings.TrimSpace(ctx.HostHomeDir) == "" || strings.TrimSpace(ctx.AccountRef) == "" {
				return nil
			}
			ownership := cachedOwnership(ctx, "cline-ownership", "cline")
			records := cachedClineSessionIndex(ctx)
			var latest *clineSessionRecord
			for i := range records {
				rec := &records[i]
				resolvedRef, _ := ownership.Resolve(rec.Cwd, rec.StartedAtMS, 0)
				if resolvedRef != ctx.AccountRef {
					continue
				}
				if latest == nil || rec.StartedAtMS > latest.StartedAtMS {
					latest = rec
				}
			}
			if latest == nil {
				return nil
			}
			ended := latest.EndedAtMS > 0 || isClineTerminalStatus(latest.Status)
			if !ended && strings.EqualFold(latest.Status, "running") && latest.PID > 0 {
				alive, known := checkPIDAlive(ctx, latest.PID)
				if known && !alive {
					ended = true
				}
			}
			if ended {
				lastAt := latest.EndedAtMS
				if lastAt == 0 {
					lastAt = latest.MessagesMtimeMS
				}
				if lastAt == 0 {
					lastAt = latest.StartedAtMS
				}
				return &TurnSignal{
					State:          TurnIdle,
					Authority:      AuthorityTurn,
					Decisive:       true,
					LastActivityAt: lastAt,
					Source:         "cline-session-store",
				}
			}
			observedAt := latest.MessagesMtimeMS
			if observedAt == 0 {
				observedAt = latest.StartedAtMS
			}
			active := observedAt > 0 && ctx.NowMS-observedAt <= ctx.TurnActiveWindowMS
			state := TurnIdle
			authority := AuthorityNone
			if active {
				state = TurnActive
				authority = AuthorityPositive
			}
			return &TurnSignal{
				State:          state,
				Authority:      authority,
				Decisive:       false,
				LastActivityAt: observedAt,
				Source:         "cline-session-store",
			}
		},
	}
}

type kiroSessionIndexRecord struct {
	MessagesPath string
	SessionID    string
	Cwd          string
	StartedAtMS  int64
	MtimeMS      int64
}

func kiroSessionStoreProbe() HarnessProbe {
	return HarnessProbe{
		ID:       "kiro-session-store",
		Label:    "Kiro 会话流（usage_summary = 每轮结束）",
		Priority: 20,
		Claims:   func(harnessID string) bool { return harnessID == "kiro" },
		Probe: func(ctx *ProbeContext) *TurnSignal {
			if ctx == nil || strings.TrimSpace(ctx.HostHomeDir) == "" || strings.TrimSpace(ctx.AccountRef) == "" {
				return nil
			}
			ownership := cachedOwnership(ctx, "kiro-ownership", "kiro")
			records := cachedKiroSessionIndex(ctx)
			var latest *kiroSessionIndexRecord
			for i := range records {
				rec := &records[i]
				resolvedRef, _ := ownership.Resolve(rec.Cwd, rec.StartedAtMS, 0)
				if resolvedRef != ctx.AccountRef {
					continue
				}
				if latest == nil || rec.MtimeMS > latest.MtimeMS {
					latest = rec
				}
			}
			if latest == nil {
				return nil
			}
			if rawLine, ok := ReadLastJSONLine(latest.MessagesPath, kiroTailBytes); ok {
				var entry struct {
					Timestamp any `json:"timestamp"`
					Payload   struct {
						Type   string `json:"type"`
						Status string `json:"status"`
					} `json:"payload"`
				}
				if json.Unmarshal(rawLine, &entry) == nil &&
					strings.EqualFold(strings.TrimSpace(entry.Payload.Type), "usage_summary") {
					at := parseTimestampMS(entry.Timestamp)
					if at == 0 {
						at = latest.MtimeMS
					}
					return &TurnSignal{
						State:          TurnIdle,
						Authority:      AuthorityTurn,
						Decisive:       true,
						LastActivityAt: at,
						Source:         "kiro-session-store",
					}
				}
			}
			active := latest.MtimeMS > 0 && ctx.NowMS-latest.MtimeMS <= ctx.TurnActiveWindowMS
			state := TurnIdle
			authority := AuthorityNone
			if active {
				state = TurnActive
				authority = AuthorityPositive
			}
			return &TurnSignal{
				State:          state,
				Authority:      authority,
				Decisive:       false,
				LastActivityAt: latest.MtimeMS,
				Source:         "kiro-session-store",
			}
		},
	}
}

func cachedOwnership(ctx *ProbeContext, cacheKey, provider string) *RegistryScopeOwnership {
	if ctx.Cache != nil {
		if existing, ok := ctx.Cache[cacheKey].(*RegistryScopeOwnership); ok && existing != nil {
			return existing
		}
	}
	ownership := NewRegistryScopeOwnership(provider, ctx.AIHomeDir, ctx.RegistryEntries)
	if ctx.Cache != nil {
		ctx.Cache[cacheKey] = ownership
	}
	return ownership
}

func cachedClineSessionIndex(ctx *ProbeContext) []clineSessionRecord {
	const cacheKey = "cline-session-index"
	if ctx.Cache != nil {
		if cached, ok := ctx.Cache[cacheKey].([]clineSessionRecord); ok {
			return cached
		}
	}
	var records []clineSessionRecord
	root := filepath.Join(ctx.HostHomeDir, ".cline", "data", "sessions")
	entries, err := os.ReadDir(root)
	if err == nil {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(names)))
		if len(names) > maxClineSessionDirs {
			names = names[:maxClineSessionDirs]
		}
		for _, name := range names {
			manifestPath := filepath.Join(root, name, name+".json")
			messagesPath := filepath.Join(root, name, name+".messages.json")
			raw, readErr := os.ReadFile(manifestPath)
			if readErr != nil {
				continue
			}
			var manifest struct {
				SessionID string `json:"session_id"`
				Cwd       string `json:"cwd"`
				PID       int    `json:"pid"`
				Status    string `json:"status"`
				StartedAt any    `json:"started_at"`
				EndedAt   any    `json:"ended_at"`
			}
			if json.Unmarshal(raw, &manifest) != nil {
				continue
			}
			var msgMtimeMS int64
			if st, statErr := os.Stat(messagesPath); statErr == nil {
				msgMtimeMS = st.ModTime().UnixMilli()
			}
			startedAtMS := parseTimestampMS(manifest.StartedAt)
			if startedAtMS == 0 {
				if idx := strings.IndexByte(name, '_'); idx > 0 {
					startedAtMS, _ = strconv.ParseInt(name[:idx], 10, 64)
				} else {
					startedAtMS, _ = strconv.ParseInt(name, 10, 64)
				}
			}
			if startedAtMS == 0 {
				if st, statErr := os.Stat(manifestPath); statErr == nil {
					startedAtMS = st.ModTime().UnixMilli()
				}
			}
			sid := strings.TrimSpace(manifest.SessionID)
			if sid == "" {
				sid = name
			}
			records = append(records, clineSessionRecord{
				SessionID:       sid,
				Cwd:             strings.TrimSpace(manifest.Cwd),
				PID:             manifest.PID,
				Status:          strings.TrimSpace(manifest.Status),
				StartedAtMS:     startedAtMS,
				EndedAtMS:       parseTimestampMS(manifest.EndedAt),
				MessagesMtimeMS: msgMtimeMS,
			})
		}
	}
	if ctx.Cache != nil {
		ctx.Cache[cacheKey] = records
	}
	return records
}

func cachedKiroSessionIndex(ctx *ProbeContext) []kiroSessionIndexRecord {
	const cacheKey = "kiro-session-index"
	if ctx.Cache != nil {
		if cached, ok := ctx.Cache[cacheKey].([]kiroSessionIndexRecord); ok {
			return cached
		}
	}
	var records []kiroSessionIndexRecord
	for _, messagesPath := range DiscoverKiroSessionFiles(ctx.HostHomeDir) {
		st, err := os.Stat(messagesPath)
		if err != nil {
			continue
		}
		meta := ReadKiroSessionMeta(messagesPath)
		records = append(records, kiroSessionIndexRecord{
			MessagesPath: messagesPath,
			SessionID:    meta.SessionID,
			Cwd:          meta.Cwd,
			StartedAtMS:  meta.StartedAtMS,
			MtimeMS:      st.ModTime().UnixMilli(),
		})
	}
	if ctx.Cache != nil {
		ctx.Cache[cacheKey] = records
	}
	return records
}

func isClineTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "failed", "error", "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func checkPIDAlive(ctx *ProbeContext, pid int) (alive bool, known bool) {
	if ctx != nil && ctx.ProcessAlive != nil {
		return ctx.ProcessAlive(pid)
	}
	if pid <= 0 {
		return false, false
	}
	err := syscall.Kill(pid, 0)
	if err == nil || err == syscall.EPERM {
		return true, true
	}
	if err == syscall.ESRCH {
		return false, true
	}
	return false, false
}
