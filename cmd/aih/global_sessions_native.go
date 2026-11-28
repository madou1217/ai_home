package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/runtime/sessionownership"
	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// 原生 Go 启动不创建 tmux pane：claude/codebuddy 等会话只在
// run/provider-session-state 或 Provider 自己的会话库里留有事实。aih ss 只读
// tmux 与 Codex 锁文件时会把它们全部漏掉，看起来就是「没有任何数据」。
//
// 这里把「仍然存活的 Provider CLI 进程」投影成只读的 NativeOnly 行：
//   - 进程身份与 cwd 从宿主进程表读取，沿父链确认由 aih 启动；
//   - 会话身份优先用 hook 状态（精确 session id），否则用该目录下最新的原生会话；
//   - 进入动作仍走 aih <provider> resume <id>，不复制 Provider 行为。
const nativeSessionActiveWindow = 10 * time.Minute

var nativeAccountRefPattern = regexp.MustCompile("(?:^|\\s)AIH_PROVIDER_ACCOUNT_REF=(acct_[a-f0-9]{20})(?:\\s|$)")
var nativeInterpreterNames = map[string]bool{
	"node": true, "nodejs": true, "bun": true, "deno": true, "python": true, "python3": true,
}

type nativeCLIProcess struct {
	PID        int
	Provider   string
	AccountRef string
	AccountID  string
	CWD        string
}

type nativeStateSession struct {
	Provider    string
	ID          string
	CWD         string
	LastEventAt int64
	TurnState   string
}

type nativeSelectedSession struct {
	Provider    string
	ID          string
	CWD         string
	Title       string
	TurnState   string
	LastEventAt int64
	ParentID    string
	Subagent    bool
	AgentName   string
}

// bindTmuxNativeStates 把 tmux 行和 hook state 的原生 session id 绑定。
// 包装在 tmux 里的 provider 进程父链是 tmux server，不会出现在原生进程
// 探测里；不绑定的话 hook/最近会话投影会再补一行同项目同 provider 的记录。
func bindTmuxNativeStates(aiHomeDir string, rows []persistent.SessionRow) {
	states := readNativeStateSessions(aiHomeDir)
	if len(rows) == 0 {
		return
	}
	used := make(map[string]bool, len(rows))
	for _, row := range rows {
		if id := strings.TrimSpace(row.NativeID); id != "" {
			used[strings.ToLower(strings.TrimSpace(row.Provider))+"\x00"+id] = true
		}
	}
	for index := range rows {
		row := &rows[index]
		if strings.TrimSpace(row.Socket) == "" || strings.TrimSpace(row.NativeID) != "" {
			continue
		}
		providerID := strings.ToLower(strings.TrimSpace(row.Provider))
		cwd := normalizeSessionProjectPath(sessionProjectPath(*row))
		best := -1
		for stateIndex, state := range states {
			if strings.ToLower(strings.TrimSpace(state.Provider)) != providerID {
				continue
			}
			if normalizeSessionProjectPath(state.CWD) != cwd {
				continue
			}
			key := providerID + "\x00" + strings.TrimSpace(state.ID)
			if used[key] {
				continue
			}
			if best < 0 || state.LastEventAt > states[best].LastEventAt {
				best = stateIndex
			}
		}
		if best < 0 {
			continue
		}
		state := states[best]
		row.NativeID = strings.TrimSpace(state.ID)
		used[providerID+"\x00"+row.NativeID] = true
	}
	// 把 NativeID 写回持久注册表，aih codex resume 才能不扫全表直接找到
	// 对应的 tmux socket/session 并 attach。
	registry, err := persistent.NewRegistry(filepath.Join(filepath.Clean(aiHomeDir), "run"))
	if err != nil {
		return
	}
	for _, row := range rows {
		if strings.TrimSpace(row.Socket) == "" || strings.TrimSpace(row.NativeID) == "" || strings.TrimSpace(row.Name) == "" {
			continue
		}
		accountRef := strings.TrimSpace(row.AccountRef)
		runtimeScope := accountRef
		gateway := row.Gateway || accountRef == ""
		if gateway {
			runtimeScope = "gateway"
		}
		_ = registry.Write(context.Background(), persistent.Entry{
			Provider:     row.Provider,
			RuntimeScope: runtimeScope,
			Gateway:      gateway,
			AccountRef:   row.AccountRef,
			Socket:       row.Socket,
			Session:      row.Name,
			CWD:          row.Path,
			Label:        row.Label,
			NativeID:     row.NativeID,
			ForwardArgs:  row.ForwardArgs,
		})
	}
}

// applyBoundNativeTitles 用 Provider 会话库给已绑定原生 id 的 tmux 行补真实
// 标题；tmux pane title 往往只是 hostname，不能当作会话名。
func applyBoundNativeTitles(ctx context.Context, runtime commandRuntime, rows []persistent.SessionRow) {
	if len(rows) == 0 {
		return
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil || aiHomeDir == "" {
		return
	}
	hostHomeDir := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHomeDir == "" {
		hostHomeDir, _ = runtime.userHomeDir()
	}
	byProvider := make(map[string]bool)
	for _, row := range rows {
		if strings.TrimSpace(row.Socket) != "" && strings.TrimSpace(row.NativeID) != "" {
			byProvider[strings.ToLower(strings.TrimSpace(row.Provider))] = true
		}
	}
	for providerID := range byProvider {
		index := nativeCandidatesForProvider(ctx, providerID, aiHomeDir, hostHomeDir)
		for rowIndex := range rows {
			row := &rows[rowIndex]
			if !strings.EqualFold(strings.TrimSpace(row.Provider), providerID) || strings.TrimSpace(row.Socket) == "" || strings.TrimSpace(row.NativeID) == "" {
				continue
			}
			for _, candidates := range index {
				for _, candidate := range candidates {
					if strings.TrimSpace(candidate.ID) != strings.TrimSpace(row.NativeID) {
						continue
					}
					if title := usableSessionTitle(candidate.Title); title != "" {
						row.Label = title
					}
				}
			}
		}
	}
}

// appendNativeProviderRows 把存活的 Provider 原生会话补进 ss 行集。只在
// 已有行没有同一 NativeID 时追加，避免和 Codex 锁投影或 tmux 行重复。
func appendNativeProviderRows(ctx context.Context, runtime commandRuntime, rows *[]persistent.SessionRow) {
	if rows == nil || ctx == nil {
		return
	}
	if err := ctx.Err(); err != nil {
		return
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	hostHomeDir := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHomeDir == "" {
		hostHomeDir, _ = runtime.userHomeDir()
	}
	processes := liveNativeCLIProcesses(ctx)
	states := readNativeStateSessions(aiHomeDir)
	if len(processes) == 0 && len(states) == 0 {
		return
	}
	now := time.Now()
	known := nativeRowIndex(*rows)
	stateGroups := groupNativeStates(states)
	processGroups := groupNativeProcesses(processes)
	candidatesByProvider := make(map[string]map[string][]resolvedCandidate)
	candidatesOf := func(providerID string) map[string][]resolvedCandidate {
		if cached, ok := candidatesByProvider[providerID]; ok {
			return cached
		}
		index := nativeCandidatesForProvider(ctx, providerID, aiHomeDir, hostHomeDir)
		candidatesByProvider[providerID] = index
		return index
	}

	appended := make([]persistent.SessionRow, 0, len(processGroups))
	for key, group := range processGroups {
		providerID, cwd := splitNativeGroupKey(key)
		candidates := candidatesOf(providerID)[cwd]
		selected := selectNativeSessions(providerID, cwd, len(group), stateGroups[key], candidates, known)
		if len(selected) == 0 {
			continue
		}
		accountRef, accountID := sharedNativeAccount(group)
		for _, session := range selected {
			row := nativeSessionRow(session)
			row.AccountRef = accountRef
			row.AccountID = accountID
			appended = append(appended, row)
			known[nativeRowKey(row.Provider, row.NativeID)] = true
		}
	}

	// 进程表不可用（Windows / 受限环境）时退回 hook 运行态：只收最近 10 分钟
	// 仍在 working/waiting 的会话，避免把崩溃残留的旧 working 状态当活跃。
	if len(processes) == 0 {
		for _, state := range states {
			if !isNativeTurnActive(state.TurnState) || state.LastEventAt <= 0 {
				continue
			}
			if now.UnixMilli()-state.LastEventAt > nativeSessionActiveWindow.Milliseconds() {
				continue
			}
			if known[nativeRowKey(state.Provider, state.ID)] {
				continue
			}
			candidates := candidatesOf(state.Provider)[state.CWD]
			selected := selectNativeSessions(state.Provider, state.CWD, 1, []nativeStateSession{state}, candidates, known)
			if len(selected) == 0 {
				continue
			}
			row := nativeSessionRow(selected[0])
			appended = append(appended, row)
			known[nativeRowKey(row.Provider, row.NativeID)] = true
		}
	}

	if len(appended) == 0 {
		return
	}
	*rows = append(*rows, appended...)
}

func nativeSessionRow(session nativeSelectedSession) persistent.SessionRow {
	activity := session.LastEventAt
	fallback := ""
	if strings.TrimSpace(session.CWD) != "" {
		fallback = filepath.Base(session.CWD)
	}
	title := usableSessionTitle(session.Title)
	if title != "" {
		title = cleanSessionTitle(title, fallback)
	}
	if title == "" {
		title = fallback
	}
	return persistent.SessionRow{
		Provider:         session.Provider,
		Origin:           persistent.SessionOriginAIHNative,
		RuntimeScope:     "native",
		Name:             nativeSessionName(session.Provider, session.ID),
		Path:             session.CWD,
		StartPath:        session.CWD,
		Label:            title,
		NativeID:         session.ID,
		ParentID:         session.ParentID,
		Subagent:         session.Subagent,
		AgentName:        session.AgentName,
		TurnState:        session.TurnState,
		Live:             true,
		NativeOnly:       true,
		CreatedAtMS:      activity,
		LastActivityAtMS: activity,
		LastActiveAtMS:   activity,
	}
}

// sharedNativeAccount 只在整组进程账号一致时返回账号身份。混合账号时
// 不能把第一个进程的账号安到所有会话上，宁可留空等详情页展示。
func sharedNativeAccount(processes []nativeCLIProcess) (string, string) {
	refs := make(map[string]bool)
	ids := make(map[string]bool)
	for _, process := range processes {
		if ref := strings.TrimSpace(process.AccountRef); ref != "" {
			refs[ref] = true
		}
		if id := strings.TrimSpace(process.AccountID); id != "" {
			ids[id] = true
		}
	}
	accountRef, accountID := "", ""
	if len(refs) == 1 {
		for ref := range refs {
			accountRef = ref
		}
	}
	if len(ids) == 1 {
		for id := range ids {
			accountID = id
		}
	}
	return accountRef, accountID
}

func nativeSessionName(providerID, sessionID string) string {
	short := strings.TrimSpace(sessionID)
	if len(short) > 8 {
		short = short[:8]
	}
	if short == "" {
		return providerID
	}
	return providerID + "-" + short
}

func nativeRowKey(providerID, sessionID string) string {
	return strings.ToLower(strings.TrimSpace(providerID)) + "\x00" + strings.TrimSpace(sessionID)
}

func nativeRowIndex(rows []persistent.SessionRow) map[string]bool {
	known := make(map[string]bool, len(rows))
	for _, row := range rows {
		if id := strings.TrimSpace(row.NativeID); id != "" {
			known[nativeRowKey(row.Provider, id)] = true
		}
	}
	return known
}

func groupNativeProcesses(processes []nativeCLIProcess) map[string][]nativeCLIProcess {
	groups := make(map[string][]nativeCLIProcess, len(processes))
	seen := make(map[int]bool, len(processes))
	for _, process := range processes {
		if process.PID <= 0 || seen[process.PID] {
			continue
		}
		cwd := normalizeSessionProjectPath(process.CWD)
		providerID := strings.ToLower(strings.TrimSpace(process.Provider))
		if cwd == "" || providerID == "" {
			continue
		}
		seen[process.PID] = true
		process.CWD = cwd
		process.Provider = providerID
		key := providerID + "\x00" + cwd
		groups[key] = append(groups[key], process)
	}
	for key := range groups {
		sort.SliceStable(groups[key], func(left, right int) bool {
			return groups[key][left].PID < groups[key][right].PID
		})
	}
	return groups
}

func splitNativeGroupKey(key string) (string, string) {
	providerID, cwd, _ := strings.Cut(key, "\x00")
	return providerID, cwd
}

func groupNativeStates(states []nativeStateSession) map[string][]nativeStateSession {
	groups := make(map[string][]nativeStateSession, len(states))
	for _, state := range states {
		cwd := normalizeSessionProjectPath(state.CWD)
		providerID := strings.ToLower(strings.TrimSpace(state.Provider))
		if cwd == "" || providerID == "" || strings.TrimSpace(state.ID) == "" {
			continue
		}
		state.CWD = cwd
		state.Provider = providerID
		key := providerID + "\x00" + cwd
		groups[key] = append(groups[key], state)
	}
	for key := range groups {
		sort.SliceStable(groups[key], func(left, right int) bool {
			return groups[key][left].LastEventAt > groups[key][right].LastEventAt
		})
	}
	return groups
}

// selectNativeSessions 按活跃度取前 limit 个会话：hook 状态优先（精确 id），
// 不够时用该目录最新原生会话补齐。已知 NativeID 不重复追加。
func selectNativeSessions(
	providerID, cwd string,
	limit int,
	states []nativeStateSession,
	candidates []resolvedCandidate,
	known map[string]bool,
) []nativeSelectedSession {
	if limit <= 0 {
		return nil
	}
	byID := make(map[string]resolvedCandidate, len(candidates))
	for _, candidate := range candidates {
		if id := strings.TrimSpace(candidate.ID); id != "" {
			byID[id] = candidate
		}
	}
	selected := make([]nativeSelectedSession, 0, limit)
	used := make(map[string]bool, limit)
	// 已有 tmux/Codex 锁行也算占用了该目录的活跃会话槽位：不能因为
	// 最新会话已经展示过，就退回补一个更旧的历史会话。
	represented := 0
	for _, state := range states {
		if len(selected)+represented >= limit {
			break
		}
		id := strings.TrimSpace(state.ID)
		if id == "" || used[id] {
			continue
		}
		if known[nativeRowKey(providerID, id)] {
			represented++
			used[id] = true
			continue
		}
		candidate, hasCandidate := byID[id]
		title := ""
		activity := state.LastEventAt
		if hasCandidate {
			title = candidate.Title
			if candidate.UpdatedAtMS > activity {
				activity = candidate.UpdatedAtMS
			}
		}
		selected = append(selected, nativeSelectedSession{
			Provider: providerID, ID: id, CWD: cwd, Title: title, TurnState: state.TurnState, LastEventAt: activity,
			ParentID: candidate.ParentID, Subagent: candidate.Subagent, AgentName: candidate.AgentName,
		})
		used[id] = true
	}
	for _, candidate := range candidates {
		if len(selected)+represented >= limit {
			break
		}
		id := strings.TrimSpace(candidate.ID)
		if id == "" || used[id] || known[nativeRowKey(providerID, id)] {
			continue
		}
		selected = append(selected, nativeSelectedSession{
			Provider: providerID, ID: id, CWD: cwd, Title: candidate.Title, LastEventAt: candidate.UpdatedAtMS,
			ParentID: candidate.ParentID, Subagent: candidate.Subagent, AgentName: candidate.AgentName,
		})
		used[id] = true
	}
	return selected
}

func readNativeStateSessions(aiHomeDir string) []nativeStateSession {
	dir := filepath.Join(filepath.Clean(aiHomeDir), "run", "provider-session-state")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sessions := make([]nativeStateSession, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if readErr != nil {
			continue
		}
		var state sessionevents.SessionState
		if json.Unmarshal(raw, &state) != nil || state.Version != sessionevents.StateVersion {
			continue
		}
		providerID := strings.ToLower(strings.TrimSpace(state.Session.Provider))
		sessionID := strings.TrimSpace(state.Session.SessionID)
		if providerID == "" || sessionID == "" || strings.EqualFold(state.TurnState, "closed") {
			continue
		}
		sessions = append(sessions, nativeStateSession{
			Provider:    providerID,
			ID:          sessionID,
			CWD:         strings.TrimSpace(state.Session.ProjectPath),
			LastEventAt: state.LastEventAt,
			TurnState:   state.TurnState,
		})
	}
	return sessions
}

// applyNativeTurnStates 用 Provider hook 的最新状态覆盖 rows 的轮次状态。
// tmux 行和 Codex 写锁行本身没有轮次信息，统一在这里补，避免每个投影
// 各自维护一份状态映射。
func applyNativeTurnStates(aiHomeDir string, rows []persistent.SessionRow) {
	states := readNativeStateSessions(aiHomeDir)
	if len(states) == 0 {
		return
	}
	// 同一会话会留下多条历史状态文件（completed 旧文件 + working 新文件）。
	// 只认 LastEventAt 最新的一条，不能按目录遍历顺序覆盖。
	latestByKey := make(map[string]nativeStateSession, len(states))
	for _, state := range states {
		key := nativeRowKey(state.Provider, state.ID)
		if key == "\x00" || strings.TrimSpace(state.TurnState) == "" {
			continue
		}
		if previous, found := latestByKey[key]; !found || state.LastEventAt >= previous.LastEventAt {
			latestByKey[key] = state
		}
	}
	owners := sessionownership.LoadAll(aiHomeDir)
	for index := range rows {
		id := strings.TrimSpace(rows[index].NativeID)
		if id == "" {
			continue
		}
		if state, found := latestByKey[nativeRowKey(rows[index].Provider, id)]; found {
			rows[index].TurnState = state.TurnState
		}
		if strings.TrimSpace(rows[index].AccountRef) == "" {
			if ref := owners[strings.ToLower(strings.TrimSpace(rows[index].Provider))][id]; ref != "" {
				rows[index].AccountRef = ref
			}
		}
	}
}

const (
	recentNativeSessionTTL  = 24 * time.Hour
	maxRecentNativeIdleRows = 12
)

// appendRecentNativeSessionRows 把最近 24 小时出现过、但当前没有进程的
// Provider 原生会话补成空闲行。旧 tmux 会话在进程结束后会一直留在列表里
// 直到回收；原生启动没有 pane，如果不补这一层，关掉终端后会话就从 ss 消失。
//
// 只补有 hook 运行记录（或已有活跃行）的 Provider，避免为了列历史去扫描
// 所有 Provider 的会话库；结果再按最近活动截断，防止把几百条历史灌进选择器。
// managedNativeIDs 返回 AIH 已知管理的原生 session id；用于区分
// 最近历史里的 aih 会话和用户直接用 Codex 开的会话。
func managedNativeIDs(aiHomeDir string, rows []persistent.SessionRow) map[string]bool {
	managed := make(map[string]bool)
	for _, state := range readNativeStateSessions(aiHomeDir) {
		managed[strings.ToLower(strings.TrimSpace(state.Provider))+"\x00"+strings.TrimSpace(state.ID)] = true
	}
	for _, row := range rows {
		providerID := strings.ToLower(strings.TrimSpace(row.Provider))
		if id := strings.TrimSpace(row.NativeID); providerID != "" && id != "" {
			managed[providerID+"\x00"+id] = true
		}
	}
	for _, entry := range persistent.ReadSessionCache(aiHomeDir, time.Now()) {
		if entry.Origin == "" || strings.EqualFold(entry.Origin, persistent.SessionOriginExternalCodex) {
			continue
		}
		providerID := strings.ToLower(strings.TrimSpace(entry.Provider))
		if id := strings.TrimSpace(entry.AgentSessionID); providerID != "" && id != "" {
			managed[providerID+"\x00"+id] = true
		}
	}
	return managed
}

func appendRecentNativeSessionRows(
	ctx context.Context,
	runtime commandRuntime,
	rows *[]persistent.SessionRow,
	allProjects bool,
) {
	if rows == nil || ctx == nil {
		return
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	hostHomeDir := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHomeDir == "" {
		hostHomeDir, _ = runtime.userHomeDir()
	}
	states := readNativeStateSessions(aiHomeDir)
	cutoff := time.Now().Add(-recentNativeSessionTTL).UnixMilli()
	providers := make(map[string]bool)
	for _, row := range *rows {
		if providerID := strings.ToLower(strings.TrimSpace(row.Provider)); providerID != "" {
			providers[providerID] = true
		}
	}
	for _, state := range states {
		if state.LastEventAt >= cutoff {
			providers[strings.ToLower(strings.TrimSpace(state.Provider))] = true
		}
	}
	if len(providers) == 0 {
		return
	}
	cwd, _ := os.Getwd()
	known := nativeRowIndex(*rows)
	managed := managedNativeIDs(aiHomeDir, *rows)
	candidates := make([]persistent.SessionRow, 0, maxRecentNativeIdleRows)
	for providerID := range providers {
		if providerID == "" {
			continue
		}
		index := nativeCandidatesForProvider(ctx, providerID, aiHomeDir, hostHomeDir)
		for projectPath, sessions := range index {
			if !allProjects && !sessionproject.MatchesCwd(projectPath, cwd) {
				continue
			}
			if isTransientProjectPath(projectPath) {
				continue
			}
			for _, session := range sessions {
				id := strings.TrimSpace(session.ID)
				if id == "" || session.UpdatedAtMS < cutoff || known[nativeRowKey(providerID, id)] {
					continue
				}
				if strings.EqualFold(providerID, "codex") && !managed[strings.ToLower(providerID)+"\x00"+id] {
					// 用户直接用 Codex 打开的 thread 不在 aih ss 里。
					continue
				}
				known[nativeRowKey(providerID, id)] = true
				candidates = append(candidates, persistent.SessionRow{
					Provider:         providerID,
					Origin:           persistent.SessionOriginAIHEnded,
					RuntimeScope:     "native",
					Name:             nativeSessionName(providerID, id),
					Path:             projectPath,
					StartPath:        projectPath,
					Label:            compactGlobalSessionTitle(session.Title),
					NativeID:         id,
					ParentID:         session.ParentID,
					Subagent:         session.Subagent,
					AgentName:        session.AgentName,
					TurnState:        "idle",
					Live:             false,
					NativeOnly:       true,
					CreatedAtMS:      session.UpdatedAtMS,
					LastActivityAtMS: session.UpdatedAtMS,
					LastActiveAtMS:   session.UpdatedAtMS,
				})
			}
		}
	}
	if len(candidates) == 0 {
		return
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		return candidates[left].LastActivityAtMS > candidates[right].LastActivityAtMS
	})
	if len(candidates) > maxRecentNativeIdleRows {
		candidates = candidates[:maxRecentNativeIdleRows]
	}
	*rows = append(*rows, candidates...)
}

// isTransientProjectPath 排除临时目录/测试产物里的会话：这些是验证
// 脚本留下的，不属于用户工作现场，不能因为"更全"就灌进选择器。
func isTransientProjectPath(path string) bool {
	text := strings.ToLower(filepath.ToSlash(filepath.Clean(strings.TrimSpace(path))))
	for _, prefix := range []string{
		"/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/",
	} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	return strings.Contains(text, "/.test-artifacts/")
}

func isNativeTurnActive(turnState string) bool {
	switch strings.ToLower(strings.TrimSpace(turnState)) {
	case "working", "waiting":
		return true
	default:
		return false
	}
}

// nativeCandidatesForProvider 只读取会话元数据，用于补标题/补最近会话。
// Codex 走 state DB，避免 rollout 全盘扫描（aih codex sessions --history 约 2s）。
func nativeCandidatesForProvider(
	ctx context.Context,
	providerID, aiHomeDir, hostHomeDir string,
) map[string][]resolvedCandidate {
	byPath := make(map[string][]resolvedCandidate)
	if strings.EqualFold(providerID, "codex") {
		if strings.TrimSpace(hostHomeDir) == "" {
			return byPath
		}
		for _, session := range sessionread.ListCodexStateSessions(ctx, hostHomeDir) {
			if session.Exec {
				continue
			}
			key := normalizeSessionProjectPath(session.CWD)
			if key == "" {
				continue
			}
			byPath[key] = append(byPath[key], resolvedCandidate{
				ID: session.ID, Title: session.Title, UpdatedAtMS: session.UpdatedAtMS,
				ParentID: session.ParentID, Subagent: session.Subagent, AgentName: session.AgentName,
			})
		}
	} else {
		byPath = sessionCandidates(ctx, providerID, aiHomeDir, hostHomeDir)
	}
	for key := range byPath {
		sort.SliceStable(byPath[key], func(left, right int) bool {
			return byPath[key][left].UpdatedAtMS > byPath[key][right].UpdatedAtMS
		})
	}
	return byPath
}

// liveNativeCLIProcesses 枚举由 aih 启动、仍在运行的 Provider CLI 进程。
// cwd 与账号取宿主事实；tmux 管理的会话已有 tmux 行，这里跳过。
func liveNativeCLIProcesses(ctx context.Context) []nativeCLIProcess {
	if goruntime.GOOS == "windows" {
		return nil
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	knownBinary := make(map[string]bool)
	knownProvider := make(map[string]bool)
	binaryByProvider := make(map[string]string)
	for _, definition := range catalog.List() {
		if definition.CLI == nil {
			continue
		}
		providerID := strings.ToLower(strings.TrimSpace(definition.ID))
		binary := strings.ToLower(strings.TrimSpace(definition.CLI.BinaryName))
		if binary == "" {
			binary = providerID
		}
		if providerID == "" || binary == "" {
			continue
		}
		knownProvider[providerID] = true
		knownBinary[binary] = true
		binaryByProvider[providerID] = binary
	}
	if len(knownBinary) == 0 {
		return nil
	}
	binaryFor := func(providerID string) string {
		normalized := strings.ToLower(strings.TrimSpace(providerID))
		if binary := binaryByProvider[normalized]; binary != "" {
			return binary
		}
		if codebuddyfamilystorage.IsFamilyProvider(normalized) {
			return "codebuddy"
		}
		return ""
	}
	output, err := exec.CommandContext(
		ctx, "ps", "eww", "-U", strconv.Itoa(os.Getuid()), "-o", "pid=,ppid=,command=",
	).Output()
	if err != nil {
		return nil
	}
	type processInfo struct {
		pid     int
		ppid    int
		command string
	}
	linePattern := regexp.MustCompile("^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$")
	byPID := make(map[int]processInfo)
	processes := make([]processInfo, 0, 256)
	for _, line := range strings.Split(string(output), "\n") {
		matches := linePattern.FindStringSubmatch(line)
		if len(matches) != 4 {
			continue
		}
		pid, pidErr := strconv.Atoi(matches[1])
		ppid, ppidErr := strconv.Atoi(matches[2])
		if pidErr != nil || ppidErr != nil || pid <= 0 {
			continue
		}
		info := processInfo{pid: pid, ppid: ppid, command: strings.TrimSpace(matches[3])}
		byPID[pid] = info
		processes = append(processes, info)
	}
	candidates := make([]nativeCLIProcess, 0, 16)
	candidatePIDs := make([]int, 0, 16)
	for _, process := range processes {
		args := strings.Fields(process.command)
		if len(args) == 0 {
			continue
		}
		binary, execIndex := nativeProviderBinaryFromArgs(args, knownBinary)
		if binary == "" || nativeCLIHeadless(args[execIndex+1:]) {
			continue
		}
		providerID := ""
		accountToken := ""
		nativeManaged := false
		current := process
		for depth := 0; depth < 8; depth++ {
			parent, found := byPID[current.ppid]
			if !found {
				break
			}
			if nativeAIHCommand(parent.command) {
				if strings.Contains(parent.command, "__native-terminal") {
					nativeManaged = true
					break
				}
				providerID, accountToken = nativeProviderFromAIHCommand(parent.command, knownProvider)
				if providerID != "" {
					break
				}
			}
			current = parent
		}
		if nativeManaged || providerID == "" {
			continue
		}
		if binaryFor(providerID) != binary {
			continue
		}
		accountRef := ""
		accountID := ""
		switch {
		case strings.HasPrefix(accountToken, "acct_"):
			accountRef = accountToken
		case isNumericAccountToken(accountToken):
			accountID = accountToken
		}
		if matches := nativeAccountRefPattern.FindStringSubmatch(process.command); len(matches) == 2 {
			accountRef = matches[1]
		}
		candidates = append(candidates, nativeCLIProcess{
			PID:        process.pid,
			Provider:   providerID,
			AccountRef: accountRef,
			AccountID:  accountID,
		})
		candidatePIDs = append(candidatePIDs, process.pid)
	}
	if len(candidates) == 0 {
		return nil
	}
	workingDirs := nativeProcessWorkingDirs(ctx, candidatePIDs)
	result := make([]nativeCLIProcess, 0, len(candidates))
	for _, candidate := range candidates {
		cwd := normalizeSessionProjectPath(workingDirs[candidate.PID])
		if cwd == "" {
			continue
		}
		candidate.CWD = cwd
		result = append(result, candidate)
	}
	return result
}

func nativeProviderBinaryFromArgs(args []string, known map[string]bool) (string, int) {
	if len(args) == 0 {
		return "", 0
	}
	execIndex := 0
	base := nativeBinaryBase(args[0])
	if nativeInterpreterNames[base] && len(args) > 1 {
		execIndex = 1
		base = nativeBinaryBase(args[1])
	}
	if known[base] {
		return base, execIndex
	}
	return "", 0
}

func nativeBinaryBase(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	text = strings.TrimRight(text, "/")
	if text == "" {
		return ""
	}
	text = filepath.Base(text)
	for _, suffix := range []string{".exe", ".cmd", ".bat", ".js", ".cjs", ".mjs"} {
		text = strings.TrimSuffix(text, suffix)
	}
	return text
}

// nativeCLIHeadless 排除一次性打印/服务式子命令，避免尾随进程被当成交互会话。
func nativeCLIHeadless(args []string) bool {
	firstPositional := ""
	for _, argument := range args {
		normalized := strings.ToLower(strings.TrimSpace(argument))
		if normalized == "-p" || normalized == "--print" || normalized == "--prompt" {
			return true
		}
		if strings.HasPrefix(normalized, "-") || firstPositional != "" {
			continue
		}
		firstPositional = normalized
	}
	switch firstPositional {
	case "exec", "app-server", "mcp", "apply", "completion", "proto":
		return true
	default:
		return false
	}
}

func nativeAIHCommand(command string) bool {
	args := strings.Fields(command)
	if len(args) == 0 {
		return false
	}
	switch nativeBinaryBase(args[0]) {
	case "aih", "aih-go":
		return true
	default:
		return false
	}
}

// nativeProviderFromAIHCommand 从 aih/aih-go 启动命令解析 provider 与账号位。
// 返回账号 token 是为了让 ss 能显示 #24，而不是把所有原生行都写成 "-"。
func nativeProviderFromAIHCommand(command string, known map[string]bool) (string, string) {
	args := strings.Fields(command)
	if len(args) < 2 {
		return "", ""
	}
	for index := 1; index < len(args); index++ {
		argument := strings.TrimSpace(args[index])
		if argument == "--provider" && index+1 < len(args) {
			return strings.ToLower(strings.TrimSpace(args[index+1])), ""
		}
		if strings.HasPrefix(argument, "--provider=") {
			return strings.ToLower(strings.TrimSpace(strings.TrimPrefix(argument, "--provider="))), ""
		}
		if strings.HasPrefix(argument, "-") {
			continue
		}
		normalized := strings.ToLower(argument)
		// Codex 原生 CLI 的内部入口：codex 二进制由 aih-go 以这个动词拉起，
		// 进程名不会再出现 aih codex，必须在这里认领。
		if normalized == "__codex-default-cli" || normalized == "__codex-cli" {
			return "codex", ""
		}
		if known[normalized] {
			account := ""
			if index+1 < len(args) {
				next := strings.TrimSpace(args[index+1])
				if isNumericAccountToken(next) || strings.HasPrefix(next, "acct_") {
					account = next
				}
			}
			return normalized, account
		}
		if isNumericAccountToken(normalized) || strings.HasPrefix(normalized, "acct_") {
			continue
		}
		return "", ""
	}
	return "", ""
}

// nativeProcessWorkingDirs 用一次 lsof 读取所有候选进程的 cwd；Linux 优先
// /proc，lsof 缺失时再回退。
func nativeProcessWorkingDirs(ctx context.Context, pids []int) map[int]string {
	result := make(map[int]string, len(pids))
	if len(pids) == 0 {
		return result
	}
	if goruntime.GOOS == "linux" {
		for _, pid := range pids {
			if target, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "cwd")); err == nil {
				result[pid] = target
			}
		}
		if len(result) == len(pids) {
			return result
		}
	}
	quoted := make([]string, 0, len(pids))
	for _, pid := range pids {
		quoted = append(quoted, strconv.Itoa(pid))
	}
	output, _ := exec.CommandContext(
		ctx, "lsof", "-a", "-d", "cwd", "-nP", "-F", "pn", "-p", strings.Join(quoted, ","),
	).Output()
	currentPID := 0
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			if pid, err := strconv.Atoi(strings.TrimSpace(line[1:])); err == nil {
				currentPID = pid
			}
		case 'n':
			if currentPID > 0 {
				if _, exists := result[currentPID]; !exists {
					result[currentPID] = strings.TrimSpace(line[1:])
				}
			}
		}
	}
	return result
}
