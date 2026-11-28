package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// runProviderSessionsList 实现 aih <family> sessions [<id>]：列出受管持久会话。
//
// 数据来自 Go 的持久会话注册表 + tmux 实时探测（persistent.TmuxSessionStore），
// 不经过 Node 的会话表/worker 链路；非交互输出固定列，便于管道消费。
func runProviderSessionsList(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	filterRef := ""
	filterID := ""
	allProjects := false
	options := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		text := strings.TrimSpace(argument)
		switch {
		case text == "":
			continue
		case text == "--all-projects":
			allProjects = true
			continue
		case isRootHelp(text):
			writeProviderSessionsUsage(runtime.stdout, providerID)
			return nil
		default:
			options = append(options, text)
		}
	}
	if len(options) > 1 {
		return fmt.Errorf("%w: 用法 aih %s sessions [id]", errInvalidCommand, providerID)
	}
	if len(options) == 1 {
		if _, err := strconv.ParseInt(options[0], 10, 64); err != nil {
			return fmt.Errorf("%w: 用法 aih %s sessions [id]", errInvalidCommand, providerID)
		}
		view, err := resolveProviderAccountView(ctx, providerID, options[0], runtime)
		if err != nil {
			return err
		}
		filterRef = view.AccountRef.String()
		filterID = strconv.FormatInt(view.CLIAccountID.Int64(), 10)
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return err
	}
	registry, err := persistent.NewRegistry(filepath.Join(aiHomeDir, "run"))
	if err != nil {
		return err
	}
	store := &persistent.TmuxSessionStore{
		AIHomeDir: aiHomeDir,
		Registry:  registry,
		Catalog:   catalog,
		Platform:  goruntime.GOOS,
		Env:       os.Getenv,
	}
	source := providerSessionSource{
		runtime:     runtime,
		store:       store,
		aiHomeDir:   aiHomeDir,
		providerID:  providerID,
		filterRef:   filterRef,
		filterID:    filterID,
		allProjects: allProjects,
	}
	rows, err := source.Rows(ctx)
	if err != nil {
		return err
	}
	labels := sessionAccountLabels(ctx, providerID, runtime)
	if !terminalWriterIsTTY(runtime.stdin) || !terminalWriterIsTTY(runtime.stdout) {
		writeSessionRows(runtime.stdout, providerID, rows, labels)
		return nil
	}
	return runSessionPicker(ctx, runtime, source, rows, labels)
}

// providerSessionSource 是 aih <p> sessions 的采集/关闭端口；列表和交互
// 选择器共用同一份数据，关闭后刷新也走同一套投影。
type providerSessionSource struct {
	runtime     commandRuntime
	store       *persistent.TmuxSessionStore
	aiHomeDir   string
	providerID  string
	filterRef   string
	filterID    string
	allProjects bool
}

func (source providerSessionSource) Rows(ctx context.Context) ([]persistent.SessionRow, error) {
	rows, err := source.store.CollectSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取持久会话失败: %w", err)
	}
	// 原生启动没有 tmux pane；只读 tmux 会让 aih <p> sessions|ss 恒为空。
	appendNativeProviderRows(ctx, source.runtime, &rows)
	appendNativeCodexRows(ctx, source.runtime, &rows)
	appendRecentNativeSessionRows(ctx, source.runtime, &rows, source.allProjects)
	applyNativeTurnStates(source.aiHomeDir, rows)
	ensureUniqueSessionTitles(rows)
	selected := make([]persistent.SessionRow, 0, len(rows))
	for _, row := range rows {
		if row.Provider != source.providerID {
			continue
		}
		if source.filterRef != "" && row.AccountRef != source.filterRef &&
			(source.filterID == "" || row.AccountID != source.filterID) {
			continue
		}
		selected = append(selected, row)
	}
	if !source.allProjects {
		cwd, cwdErr := os.Getwd()
		if cwdErr != nil {
			return nil, cwdErr
		}
		selected = persistent.FilterSessionsByCwd(selected, cwd)
	}
	sortSessionRowsForDisplay(selected)
	return selected, nil
}

func (source providerSessionSource) Close(ctx context.Context, row persistent.SessionRow) error {
	if row.NativeOnly {
		return fmt.Errorf("原生会话不能从 aih %s sessions 关闭；退出该 Provider 进程后再刷新", source.providerID)
	}
	return source.store.CloseSession(ctx, row)
}

// sessionAccountLabels 读取 #<id> 与显示名；管理面不可用时退化为空表，
// 列表仍然只依赖本地注册表与 tmux。
func sessionAccountLabels(
	ctx context.Context,
	providerID string,
	runtime commandRuntime,
) map[string]string {
	labels := make(map[string]string)
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return labels
	}
	accounts, err := listProviderAccounts(ctx, client, providerID)
	if err != nil {
		return labels
	}
	states, _ := client.ListAccountUIStates(ctx)
	names := make(map[string]string, len(states))
	for _, state := range states {
		names[state.AccountRef] = state.DisplayName
	}
	for _, account := range accounts {
		name := strings.TrimSpace(account.DisplayName)
		if name == "" {
			name = strings.TrimSpace(names[account.AccountRef.String()])
		}
		if name == "" {
			name = strings.TrimSpace(account.Email)
		}
		label := "#" + strconv.FormatInt(account.CLIAccountID.Int64(), 10)
		if name != "" {
			label += " " + name
		}
		labels[account.AccountRef.String()] = label
	}
	return labels
}

// writeSessionRows 输出固定列：状态 / 账号 / 会话名称 / 会话ID / 项目。
func writeSessionRows(
	output io.Writer,
	providerID string,
	rows []persistent.SessionRow,
	labels map[string]string,
) {
	if len(rows) == 0 {
		_, _ = fmt.Fprintf(output, "%s：当前没有活跃的持久会话。\n", providerID)
		return
	}
	_, _ = fmt.Fprintf(output, "%s 持久会话（%d）：\n", providerID, len(rows))
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(writer, "状态\t账号\t会话名称\t会话ID\t项目\t最近活动")
	for _, row := range rows {
		status := globalSessionStatus(row)
		account := strings.TrimSpace(labels[row.AccountRef])
		if account == "" && strings.TrimSpace(row.AccountID) != "" {
			account = "#" + strings.TrimSpace(row.AccountID)
		}
		if account == "" {
			account = shortAccountRef(row.AccountRef)
		}
		title := displaySessionTitle(row)
		project := sessionProjectPath(row)
		sessionID := strings.TrimSpace(row.Name)
		if row.NativeOnly {
			if native := strings.TrimSpace(row.NativeID); native != "" {
				sessionID = native
			}
		} else if sessionID == "" {
			sessionID = row.Socket
		}
		_, _ = fmt.Fprintf(
			writer,
			"%s\t%s\t%s\t%s\t%s\t%s\n",
			status,
			account,
			title,
			sessionID,
			project,
			sessionActivityLabel(row),
		)
	}
	_ = writer.Flush()
}

// sessionActivityLabel 优先显示最近活动时间，缺失时回退创建时间。
func sessionActivityLabel(row persistent.SessionRow) string {
	millis := row.LastActivityAtMS
	if millis == 0 {
		millis = row.LastActiveAtMS
	}
	if millis == 0 {
		millis = row.CreatedAtMS
	}
	if millis == 0 {
		return "-"
	}
	return time.UnixMilli(millis).Format("2006-01-02 15:04")
}

// shortAccountRef 在管理面不可用时展示 ref 尾段。
func shortAccountRef(ref string) string {
	text := strings.TrimSpace(ref)
	if len(text) <= 10 {
		return text
	}
	return "…" + text[len(text)-8:]
}
