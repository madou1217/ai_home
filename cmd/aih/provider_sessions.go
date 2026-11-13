package main

import (
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
	"github.com/madou1217/ai_home/internal/sessionscan/codexindex"
)

var (
	commandNamePattern = regexp.MustCompile("(?s)<command-name>(.*?)</command-name>")
	commandArgsPattern = regexp.MustCompile("(?s)<command-args>(.*?)</command-args>")
)

type unlimitedScanBudget struct{}

func (unlimitedScanBudget) Take() bool      { return true }
func (unlimitedScanBudget) OutOfTime() bool { return false }

// runProviderSessionsHistory 实现 aih <family> sessions --history [--limit N]。
//
// 只读宿主 JSONL 事实，不打开 Node 账号索引或 WorkBuddy SQLite；项目/标题
// 优先级由 sessionscan/codebuddy 复刻 Node。
func runProviderSessionsHistory(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	limit := 20
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if isRootHelp(argument) {
			writeProviderSessionsUsage(runtime.stdout, providerID)
			return nil
		}
		switch argument {
		case "--history":
			continue
		case "--limit", "-n":
			if index+1 >= len(arguments) {
				return fmt.Errorf("%w: --limit 缺少值", errInvalidCommand)
			}
			value, parseErr := strconv.Atoi(arguments[index+1])
			if parseErr != nil || value < 1 {
				return fmt.Errorf("%w: --limit 必须是正整数", errInvalidCommand)
			}
			limit = value
			index++
		default:
			return fmt.Errorf("%w: 未知 sessions 参数 %s", errInvalidCommand, argument)
		}
	}
	hostHome := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHome == "" {
		var err error
		hostHome, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	type row struct {
		id        string
		title     string
		path      string
		updatedAt int64
	}
	rows := make([]row, 0)
	if providerID == "codex" {
		// Codex 没有项目库：从 rollout 索引直接列会话（id/cwd/标题/更新时间）。
		for _, session := range codexindex.List(hostHome) {
			title := usableSessionTitle(session.Title)
			if title == "" {
				title = "-"
			}
			rows = append(rows, row{
				id:        session.ID,
				title:     title,
				path:      session.CWD,
				updatedAt: session.UpdatedAtMS,
			})
		}
	} else {
		projects := codebuddy.ReadProjects(hostHome, providerID, unlimitedScanBudget{})
		for _, project := range projects {
			projectPath := strings.TrimSpace(project.Path)
			if projectPath == "" {
				projectPath = strings.TrimSpace(project.Name)
			}
			for _, session := range project.Sessions {
				fallback := strings.TrimSpace(project.Name)
				title := cleanSessionTitle(session.Title, fallback)
				if title == "" {
					title = fallback
				}
				rows = append(rows, row{
					id:        session.ID,
					title:     title,
					path:      projectPath,
					updatedAt: session.UpdatedAt,
				})
			}
		}
	}
	sort.Slice(rows, func(left, right int) bool {
		return rows[left].updatedAt > rows[right].updatedAt
	})
	total := len(rows)
	if limit > total {
		limit = total
	}
	_, _ = fmt.Fprintf(runtime.stdout, "%s 会话历史（宿主，最近 %d/%d）：\n", providerID, limit, total)
	for _, item := range rows[:limit] {
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"  %s  %s  %s  %s\n",
			item.id,
			formatSessionTime(item.updatedAt),
			item.path,
			item.title,
		)
	}
	// 家族 CLI 没有 fork 入口，不要广告一个必然被拒绝的命令。
	_, _ = fmt.Fprintf(runtime.stdout, "续接：aih %s resume <id>\n", providerID)
	return nil
}

func cleanSessionTitle(title string, fallback string) string {
	text := strings.TrimSpace(title)
	if match := commandArgsPattern.FindStringSubmatch(text); len(match) == 2 {
		if args := strings.TrimSpace(match[1]); args != "" {
			return truncateTitle(args)
		}
	}
	if commandNamePattern.MatchString(text) {
		return fallback
	}
	return text
}

func truncateTitle(value string) string {
	runes := []rune(value)
	if len(runes) > 120 {
		runes = runes[:120]
	}
	return strings.TrimSpace(string(runes))
}

func containsArgument(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func formatSessionTime(ms int64) string {
	if ms <= 0 {
		return "unknown"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04:05")
}

func writeProviderSessionsUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "用法:\n  aih %s sessions --history [--limit N]\n", providerID)
}
