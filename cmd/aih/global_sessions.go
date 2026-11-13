package main

import (
	"context"
	"fmt"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
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
	if len(arguments) == 0 {
		return runGlobalSessionPicker(ctx, runtime)
	}
	if len(arguments) > 1 {
		return fmt.Errorf("%w: 用法 aih ss --list", errInvalidCommand)
	}
	token := strings.TrimSpace(arguments[0])
	if token == "--help" || token == "-h" || token == "help" {
		writeGlobalSessionsUsage(runtime.stdout)
		return nil
	}
	if !globalSessionDetailTokens[token] {
		return runGlobalSessionTarget(ctx, token, runtime)
	}
	rows, err := collectGlobalRows(ctx, runtime)
	if err != nil {
		return err
	}
	writeGlobalSessionGroups(runtime.stdout, rows, collectGlobalLabels(ctx, rows, runtime))
	return nil
}

// collectGlobalRows 读取全部受管持久会话的实时行。
func collectGlobalRows(ctx context.Context, runtime commandRuntime) ([]persistent.SessionRow, error) {
	store, err := globalSessionStore(runtime)
	if err != nil {
		return nil, err
	}
	rows, err := store.CollectSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("读取持久会话失败: %w", err)
	}
	// 与 Node 共用标题缓存：先用未过期缓存补标题/原生会话 id，再把本次结果写回。
	now := time.Now()
	persistent.ApplySessionCache(rows, persistent.ReadSessionCache(store.AIHomeDir, now))
	_ = persistent.WriteSessionCache(store.AIHomeDir, rows, now)
	return rows, nil
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
		project := strings.TrimSpace(row.Path)
		if project == "" {
			project = strings.TrimSpace(row.StartPath)
		}
		if project == "" {
			project = "-"
		}
		if _, exists := groups[project]; !exists {
			order = append(order, project)
		}
		groups[project] = append(groups[project], row)
	}
	sort.Strings(order)
	result := make([]sessionGroup, 0, len(order))
	for _, project := range order {
		groupRows := groups[project]
		sort.SliceStable(groupRows, func(left, right int) bool {
			return sessionActivityMillis(groupRows[left]) > sessionActivityMillis(groupRows[right])
		})
		result = append(result, sessionGroup{Project: project, Rows: groupRows})
	}
	return result
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
		_, _ = fmt.Fprintln(writer, "  状态\tprovider\t账号\t会话名称\t会话ID\t最近活动")
		for _, row := range group.Rows {
			_, _ = fmt.Fprintf(
				writer,
				"  %s\t%s\t%s\t%s\t%s\t%s\n",
				globalSessionStatus(row),
				row.Provider,
				globalSessionAccount(row, labels),
				globalSessionTitle(row),
				globalSessionID(row),
				globalSessionActivityLabel(row),
			)
		}
		_ = writer.Flush()
	}
	_, _ = fmt.Fprintln(output, "\n提示（● 运行中 / ○ 空闲）：Enter=进入，c=复制ID，y=复制命令，d=详情，x=关闭选中，X=关闭闲置。")
}

func globalSessionStatus(row persistent.SessionRow) string {
	if row.Live {
		return "● 运行中"
	}
	return "○ 空闲"
}

func globalSessionAccount(row persistent.SessionRow, labels map[string]string) string {
	if label := strings.TrimSpace(labels[row.AccountRef]); label != "" {
		return label
	}
	return shortAccountRef(row.AccountRef)
}

func globalSessionTitle(row persistent.SessionRow) string {
	for _, candidate := range []string{row.Label, row.Title, row.WindowName} {
		if title := strings.TrimSpace(candidate); title != "" {
			return title
		}
	}
	return "-"
}

func globalSessionID(row persistent.SessionRow) string {
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
	_, _ = fmt.Fprintln(output, "  aih ss --list             按项目预览所有会话")
	_, _ = fmt.Fprintln(output, "  aih ss --refresh          强制重新采集（默认走缓存，打开更快）")
}
