package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// globalSessionDetailTokens 与 Node GLOBAL_SESSION_DETAIL_TOKENS 一致：
// aih ss 的只读列表形态（输出按项目分组）。
var globalSessionDetailTokens = map[string]bool{
	"--list": true, "-l": true, "--detail": true, "--details": true,
	"--verbose": true, "-v": true, "-vv": true, "-vvv": true,
	"list": true, "detail": true, "details": true, "vvv": true,
}

// runGlobalSessions 实现 aih ss|sessions --list/-l/--detail：只读列出所有受管
// 持久会话，按项目分组。交互 picker 与按名字进入仍由 Node 组合根处理。
func runGlobalSessions(
	ctx context.Context,
	arguments []string,
	runtime commandRuntime,
) error {
	allProjects := false
	jsonOutput := false
	previewOutput := false
	options := make([]string, 0, len(arguments))
	for _, arg := range arguments {
		switch arg {
		case "--all-projects", "--all":
			allProjects = true
		case "--json":
			jsonOutput = true
		case "--preview":
			previewOutput = true
		default:
			options = append(options, arg)
		}
	}
	arguments = options
	if len(arguments) == 0 {
		return runGlobalSessionPicker(ctx, runtime, false, allProjects)
	}
	if len(arguments) > 1 {
		return fmt.Errorf("%w: 用法 aih ss --list", errInvalidCommand)
	}
	token := strings.TrimSpace(arguments[0])
	if token == "--help" || token == "-h" || token == "help" {
		writeGlobalSessionsUsage(runtime.stdout)
		return nil
	}
	if token == "--refresh" || token == "-r" {
		return runGlobalSessionPicker(ctx, runtime, true, allProjects)
	}
	if !globalSessionDetailTokens[token] {
		return runGlobalSessionTarget(ctx, token, runtime, allProjects)
	}
	rows, err := collectGlobalRows(ctx, runtime, allProjects)
	if err != nil {
		return err
	}
	if jsonOutput {
		encoder := json.NewEncoder(runtime.stdout)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(map[string]any{
			"ok":       true,
			"sessions": buildGlobalSessionJSONRows(ctx, runtime, rows, previewOutput),
		})
	}
	writeGlobalSessionGroups(runtime.stdout, rows, collectGlobalLabels(ctx, rows, runtime))
	return nil
}

// collectGlobalRows 读取全部受管持久会话的实时行。
func collectGlobalRows(ctx context.Context, runtime commandRuntime, allProjects ...bool) ([]persistent.SessionRow, error) {
	return collectGlobalRowsMode(ctx, runtime, false, allProjects...)
}

// collectGlobalRowsMode 的 refresh=true 时跳过标题缓存，直接用原生会话库
// 重新解析标题/原生 id；其余步骤与普通列表完全一致。
func collectGlobalRowsMode(
	ctx context.Context,
	runtime commandRuntime,
	refresh bool,
	allProjects ...bool,
) ([]persistent.SessionRow, error) {
	store, err := globalSessionStore(runtime)
	if err != nil {
		return nil, err
	}
	rows, err := store.CollectSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取持久会话失败: %w", err)
	}
	now := time.Now()
	if refresh {
		resolveSessionTitles(ctx, runtime, rows)
	} else {
		// 与 Node 共用标题缓存：先用未过期缓存补标题/原生会话 id，再把本次结果写回。
		persistent.ApplySessionCache(rows, persistent.ReadSessionCache(store.AIHomeDir, now))
	}
	// 原生进程行必须先于 Codex 写锁投影生成：前者能给出真实的运行/等待
	// 状态，后者只补没有进程的 thread，避免同一个会话出现两行。
	appendNativeProviderRows(ctx, runtime, &rows)
	appendNativeCodexRows(ctx, runtime, &rows)
	// 范围规则：显式 --all-projects 或当前位于 $HOME 时显示全部；当前目录
	// 有会话时只显示当前项目；当前目录没有会话时回退到全部，避免用户
	// 站在空目录里以为所有会话都丢了。
	visibleAll, _ := resolveSessionScope(rows, runtime, allProjectsRequested(allProjects...))
	appendRecentNativeSessionRows(ctx, runtime, &rows, visibleAll)
	applyNativeTurnStates(store.AIHomeDir, rows)
	annotateLatestMessages(ctx, runtime, store.AIHomeDir, rows)
	rows = filterDismissedSessionRows(rows, readSSDismissed(store.AIHomeDir, now))
	ensureUniqueSessionTitles(rows)
	sortSessionRowsForDisplay(rows)
	_ = persistent.WriteSessionCache(store.AIHomeDir, rows, now)
	return scopeGlobalSessionRows(rows, visibleAll)
}

// appendNativeCodexRows 把 Go 原生 Codex 进程对应的 state.sqlite 会话投影到 ss。
// 原生 Go 启动不创建 tmux pane；如果这里只看 TmuxSessionStore，aih ss 会错误地
// 显示为空，即使 Codex thread 和写锁都还活着。该投影只保存标题/路径/原生 id，
// 不复制消息正文；NativeOnly 让进入动作走 `aih codex resume <thread>`。
func appendNativeCodexRows(ctx context.Context, runtime commandRuntime, rows *[]persistent.SessionRow) {
	if rows == nil {
		return
	}
	hostHome := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME"))
	if hostHome == "" {
		hostHome, _ = runtime.userHomeDir()
	}
	if hostHome == "" {
		return
	}
	known := make(map[string]bool)
	for _, row := range *rows {
		if row.Provider == "codex" && strings.TrimSpace(row.NativeID) != "" {
			known[strings.TrimSpace(row.NativeID)] = true
		}
	}
	for _, session := range sessionread.ListCodexStateSessions(ctx, hostHome) {
		id := strings.TrimSpace(session.ID)
		// ss is a live/persistent-session view, not a second Codex history
		// command. State rows without a held writer lock are historical rows.
		if id == "" || !isCodexThreadID(id) || known[id] || strings.TrimSpace(session.CWD) == "" {
			continue
		}
		locked := codexThreadLockHeld(hostHome, id)
		if !locked {
			continue
		}
		updated := session.UpdatedAtMS
		if updated == 0 {
			updated = time.Now().UnixMilli()
		}
		*rows = append(*rows, persistent.SessionRow{
			Provider:     "codex",
			RuntimeScope: "native",
			Socket:       "",
			Name:         "codex-" + id[:8],
			Path:         session.CWD,
			StartPath:    session.CWD,
			Title:        compactGlobalSessionTitle(session.Title),
			NativeID:     id,
			// 写锁只证明 thread 被 Codex app-server 打开过，不等于有交互
			// CLI 在跑：0.171 的共享 app-server 会同时持有多个 thread 锁。
			// 真正在跑的会话已由进程投影标记 Live，这里只补空闲行。
			Live:             false,
			CreatedAtMS:      updated,
			LastActivityAtMS: updated,
			LastActiveAtMS:   updated,
			NativeOnly:       true,
		})
		known[id] = true
	}
}

func compactGlobalSessionTitle(value string) string {
	return compactSessionTitle(value)
}

func codexThreadLockHeld(hostHome, threadID string) bool {
	lock := filepath.Join(hostHome, providerroot.ConfigDir("codex"), "thread-writer-locks", threadID+".lock")
	if _, err := os.Stat(lock); err != nil {
		return false
	}
	return len(lockHolderPIDs(lock)) > 0
}

// cachedGlobalRows 用 30 分钟内的 ss-rows.json 先渲染首帧；真实采集
// 在 picker 起来后由后台刷新接管，避免终端空等 2~3 秒。
func cachedGlobalRows(aiHomeDir string) []persistent.SessionRow {
	entries := persistent.ReadSessionCache(aiHomeDir, time.Now())
	if len(entries) == 0 {
		return nil
	}
	rows := make([]persistent.SessionRow, 0, len(entries))
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			continue
		}
		rows = append(rows, persistent.SessionRow{
			Provider:         strings.TrimSpace(entry.Provider),
			Name:             name,
			Label:            strings.TrimSpace(entry.Title),
			NativeID:         strings.TrimSpace(entry.AgentSessionID),
			Path:             strings.TrimSpace(entry.ProjectPath),
			StartPath:        strings.TrimSpace(entry.ProjectPath),
			Socket:           strings.TrimSpace(entry.Socket),
			NativeOnly:       entry.NativeOnly || (entry.Socket == "" && strings.TrimSpace(entry.AgentSessionID) != ""),
			AccountRef:       strings.TrimSpace(entry.AccountRef),
			AccountID:        strings.TrimSpace(entry.AccountID),
			TurnState:        strings.TrimSpace(entry.TurnState),
			LastMessage:      strings.TrimSpace(entry.LastMessage),
			LastMessageRole:  strings.TrimSpace(entry.LastMessageRole),
			LastMessageAtMS:  entry.LastMessageAt,
			Live:             entry.Live,
			CreatedAtMS:      entry.CreatedAt,
			LastActivityAtMS: entry.UpdatedAt,
			LastActiveAtMS:   entry.UpdatedAt,
		})
	}
	ensureUniqueSessionTitles(rows)
	sortSessionRowsForDisplay(rows)
	return rows
}

func allProjectsRequested(values ...bool) bool {
	return len(values) > 0 && values[0]
}

func scopeGlobalSessionRows(rows []persistent.SessionRow, allProjects bool) ([]persistent.SessionRow, error) {
	if allProjects {
		return rows, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	return persistent.FilterSessionsByCwd(rows, cwd), nil
}

func resolveSessionScope(rows []persistent.SessionRow, runtime commandRuntime, explicitAll bool) (bool, string) {
	if explicitAll {
		return true, "全部项目"
	}
	cwd, err := os.Getwd()
	if err != nil {
		return true, "全部项目"
	}
	if isSessionHomeDir(cwd, runtime) {
		return true, "全部项目（HOME）"
	}
	if len(persistent.FilterSessionsByCwd(rows, cwd)) > 0 {
		return false, "当前项目"
	}
	return true, "全部项目（当前目录无会话）"
}

func isSessionHomeDir(cwd string, runtime commandRuntime) bool {
	candidates := make([]string, 0, 3)
	if home, err := runtime.userHomeDir(); err == nil {
		candidates = append(candidates, home)
	}
	if host := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOST_HOME")); host != "" {
		candidates = append(candidates, host)
	}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, home)
	}
	for _, home := range candidates {
		if strings.TrimSpace(home) != "" && sessionproject.MatchesCwd(home, cwd) {
			return true
		}
	}
	return false
}

// sessionGroup 是一个项目下的会话集合。
type sessionGroup struct {
	Project string
	Rows    []persistent.SessionRow
}

// groupSessionsByProject 按项目路径分组；组间按路径排序，组内按最近活动倒序。
func groupSessionsByProject(rows []persistent.SessionRow) []sessionGroup {
	groups := make(map[string][]persistent.SessionRow)
	order := make([]string, 0)
	for _, row := range rows {
		project := sessionProjectPath(row)
		if _, exists := groups[project]; !exists {
			order = append(order, project)
		}
		groups[project] = append(groups[project], row)
	}
	cwd, _ := os.Getwd()
	sort.SliceStable(order, func(left, right int) bool {
		leftHere := sessionproject.MatchesCwd(order[left], cwd)
		rightHere := sessionproject.MatchesCwd(order[right], cwd)
		if leftHere != rightHere {
			return leftHere
		}
		return order[left] < order[right]
	})
	result := make([]sessionGroup, 0, len(order))
	for _, project := range order {
		groupRows := groups[project]
		sortSessionRowsForDisplay(groupRows)
		result = append(result, sessionGroup{Project: project, Rows: groupRows})
	}
	return result
}

// sortSessionRowsForDisplay 先按项目聚在一起，组内运行中优先、再按最近活动。
// 选择器和非交互列表共用，避免两处顺序不一致。
func sortSessionRowsForDisplay(rows []persistent.SessionRow) {
	if len(rows) < 2 {
		return
	}
	cwd, _ := os.Getwd()
	sort.SliceStable(rows, func(left, right int) bool {
		leftProject, rightProject := sessionProjectPath(rows[left]), sessionProjectPath(rows[right])
		if leftProject != rightProject {
			leftHere := sessionproject.MatchesCwd(leftProject, cwd)
			rightHere := sessionproject.MatchesCwd(rightProject, cwd)
			if leftHere != rightHere {
				return leftHere
			}
			return leftProject < rightProject
		}
		leftRank, rightRank := globalSessionStatusRank(rows[left]), globalSessionStatusRank(rows[right])
		if leftRank != rightRank {
			return leftRank < rightRank
		}
		return sessionActivityMillis(rows[left]) > sessionActivityMillis(rows[right])
	})
}

func sessionProjectPath(row persistent.SessionRow) string {
	project := strings.TrimSpace(row.Path)
	if project == "" {
		project = strings.TrimSpace(row.StartPath)
	}
	if project == "" {
		return "-"
	}
	return project
}

func sessionActivityMillis(row persistent.SessionRow) int64 {
	if row.LastActivityAtMS != 0 {
		return row.LastActivityAtMS
	}
	if row.LastActiveAtMS != 0 {
		return row.LastActiveAtMS
	}
	return persistent.CreatedAtMillis(row)
}

// writeGlobalSessionGroups 渲染按项目分组的固定列表。
func writeGlobalSessionGroups(
	output io.Writer,
	rows []persistent.SessionRow,
	labels map[string]string,
) {
	groups := groupSessionsByProject(rows)
	if len(groups) == 0 {
		_, _ = fmt.Fprintln(output, "[aih] 当前没有活跃的持久会话。")
		return
	}
	_, _ = fmt.Fprintln(output, "[aih] 活跃持久会话：")
	for _, group := range groups {
		_, _ = fmt.Fprintf(output, "\n  项目：%s\n", group.Project)
		writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(writer, "  状态\tprovider\t账号\t会话名称\t最新消息\t会话ID\t最近活动")
		for _, row := range group.Rows {
			_, _ = fmt.Fprintf(
				writer,
				"  %s\t%s\t%s\t%s\t%s\t%s\t%s\n",
				globalSessionStatus(row),
				row.Provider,
				globalSessionAccount(row, labels),
				globalSessionTitle(row),
				truncateDisplay(pickerLatestMessage(row), 60),
				globalSessionID(row),
				globalSessionActivityLabel(row),
			)
		}
		_ = writer.Flush()
	}
	_, _ = fmt.Fprintln(output, "\n提示（● 运行中 / ◐ 等待输入 / ○ 空闲 / ✕ 已结束）：Enter=进入，c=复制ID，y=复制命令，d=详情，x=关闭选中，X=关闭空闲/已结束。")
}

// sessionStatus 把「进程是否存活」和「轮次是否在跑」收敛成一个状态。
// working/waiting 来自 Provider hook；没有 hook 时按 tmux 附着情况退化。
type sessionStatus struct {
	Kind  string
	Icon  string
	Label string
}

func globalSessionState(row persistent.SessionRow) sessionStatus {
	// tmux 会话即使没有客户端附着，pane 仍在，可以直接 attach；原生行
	// 没有进程就是已结束，只能 resume。两者不能共用"空闲"。
	if row.PaneDead {
		return sessionStatus{Kind: "ended", Icon: "✕", Label: "已结束"}
	}
	alive := row.Live || strings.TrimSpace(row.Socket) != "" || row.PanePID > 0
	if !alive {
		return sessionStatus{Kind: "ended", Icon: "✕", Label: "已结束"}
	}
	switch strings.ToLower(strings.TrimSpace(row.TurnState)) {
	case "working":
		return sessionStatus{Kind: "running", Icon: "●", Label: "运行中"}
	case "waiting":
		return sessionStatus{Kind: "waiting", Icon: "◐", Label: "等待输入"}
	case "completed", "idle":
		return sessionStatus{Kind: "idle", Icon: "○", Label: "空闲"}
	}
	if row.Live {
		return sessionStatus{Kind: "running", Icon: "●", Label: "运行中"}
	}
	return sessionStatus{Kind: "idle", Icon: "○", Label: "空闲"}
}

func globalSessionStatus(row persistent.SessionRow) string {
	state := globalSessionState(row)
	return state.Icon + " " + state.Label
}

func globalSessionStatusRank(row persistent.SessionRow) int {
	switch globalSessionState(row).Kind {
	case "running":
		return 0
	case "waiting":
		return 1
	default:
		return 2
	}
}

func globalSessionAccount(row persistent.SessionRow, labels map[string]string) string {
	if label := strings.TrimSpace(labels[row.AccountRef]); label != "" {
		return label
	}
	if id := strings.TrimSpace(row.AccountID); id != "" {
		return "#" + id
	}
	if row.Gateway {
		return "gateway"
	}
	if strings.TrimSpace(row.AccountRef) == "" {
		return "-"
	}
	return shortAccountRef(row.AccountRef)
}

func globalSessionTitle(row persistent.SessionRow) string {
	return displaySessionTitle(row)
}

func globalSessionID(row persistent.SessionRow) string {
	if row.NativeOnly {
		if native := strings.TrimSpace(row.NativeID); native != "" {
			return native
		}
	}
	if name := strings.TrimSpace(row.Name); name != "" {
		return name
	}
	return row.Socket
}

func globalSessionActivityLabel(row persistent.SessionRow) string {
	millis := sessionActivityMillis(row)
	if millis == 0 {
		return "-"
	}
	return time.UnixMilli(millis).Format("2006-01-02 15:04")
}

func writeGlobalSessionsUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "Usage:")
	_, _ = fmt.Fprintln(output, "  aih ss                    上下选择活跃持久会话")
	_, _ = fmt.Fprintln(output, "  aih ss <名字>             直接进入指定会话（TAB 可补名字/项目描述）")
	_, _ = fmt.Fprintln(output, "  aih ss --list             预览当前项目会话")
	_, _ = fmt.Fprintln(output, "  aih ss --all-projects     显式查看全部项目（也可用 --all）")
	_, _ = fmt.Fprintln(output, "  aih ss --refresh          强制重新采集（默认走缓存，打开更快）")
	_, _ = fmt.Fprintln(output, "  aih ss --list --json      机器可读的会话列表")
	_, _ = fmt.Fprintln(output, "  aih ss --list --json --preview  附带实时终端/对话内容预览")
}
