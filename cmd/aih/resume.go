package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type resumeOptions struct {
	provider string
	account  string
	limit    int
	json     bool
	help     bool
	query    string
}

type resumeSession struct {
	ID             string `json:"id"`
	Provider       string `json:"provider"`
	Title          string `json:"title"`
	ProjectPath    string `json:"projectPath"`
	ProjectDirName string `json:"projectDirName"`
	UpdatedAt      int64  `json:"updatedAt"`
}

var resumeProviderPriority = []string{
	"codebuddy", "codebuddycn", "codex", "claude", "gemini", "agy",
	"opencode", "grok", "kimi", "kiro", "cline", "qoder", "qodercn",
	"zcode", "workbuddy", "workbuddycn",
}

func runResume(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "resume" {
		return false, nil
	}
	options, err := parseResumeOptions(arguments[1:])
	if err != nil {
		return true, err
	}
	if options.help {
		writeResumeHelp(runtime)
		return true, nil
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	sessions, err := listResumeSessions(ctx, home, options)
	if err != nil {
		return true, err
	}
	if options.json {
		encoded, err := json.MarshalIndent(map[string]any{"ok": true, "sessions": sessions}, "", "  ")
		if err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return true, nil
	}
	if len(sessions) == 0 {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 没找到会话。试试 aih <cli> sessions --history 或 aih <cli> resume <id>")
		return true, &cliExitError{code: 1}
	}
	_, _ = fmt.Fprintln(runtime.stdout, "\x1b[36m[aih]\x1b[0m 选择要续聊的会话（回车 = 第一条，q 退出）：")
	_, _ = fmt.Fprintln(runtime.stdout)
	cwd, _ := os.Getwd()
	_, _ = fmt.Fprintln(runtime.stdout, formatResumeList(sessions, cwd))
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprint(runtime.stdout, "> ")
	reader := bufio.NewReader(runtime.stdin)
	answer, _ := reader.ReadString(byte(10))
	answer = strings.TrimSpace(answer)
	if strings.EqualFold(answer, "q") {
		return true, nil
	}
	picked := pickResumeSession(sessions, answer)
	if picked == nil {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 没有匹配的会话")
		return true, &cliExitError{code: 1}
	}
	launchArgs := []string{picked.Provider}
	if options.account != "" {
		launchArgs = append(launchArgs, options.account)
	}
	launchArgs = append(launchArgs, "resume", picked.ID)
	_, _ = fmt.Fprintf(runtime.stdout, "\x1b[36m[aih]\x1b[0m %s resume %s\n", picked.Provider, picked.ID)
	executable, err := os.Executable()
	if err != nil {
		return true, err
	}
	command := exec.CommandContext(ctx, executable, launchArgs...)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	command.Env = os.Environ()
	return true, command.Run()
}

func parseResumeOptions(args []string) (resumeOptions, error) {
	options := resumeOptions{limit: 20}
	rest := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		switch token {
		case "--provider":
			if index+1 >= len(args) {
				return options, errors.New("--provider requires a value")
			}
			index++
			options.provider = strings.ToLower(strings.TrimSpace(args[index]))
		case "--account":
			if index+1 >= len(args) {
				return options, errors.New("--account requires a value")
			}
			index++
			options.account = strings.TrimSpace(args[index])
		case "--limit":
			if index+1 >= len(args) {
				return options, errors.New("--limit requires a value")
			}
			index++
			value, err := strconv.Atoi(strings.TrimSpace(args[index]))
			if err != nil || value < 1 {
				return options, errors.New("--limit must be a positive number")
			}
			options.limit = value
		case "--json":
			options.json = true
		case "--help", "-h", "help":
			options.help = true
		default:
			if strings.HasPrefix(token, "-") {
				return options, fmt.Errorf("unknown option: %s", token)
			}
			rest = append(rest, token)
		}
	}
	options.query = strings.TrimSpace(strings.Join(rest, " "))
	return options, nil
}

func listResumeSessions(ctx context.Context, home string, options resumeOptions) ([]resumeSession, error) {
	path, err := appstate.DatabasePath(home)
	if err != nil {
		return nil, err
	}
	db, err := appstate.OpenReadOnly(ctx, path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	query := "SELECT provider, project_path, project_dir_name, session_id, title, updated_at_ms FROM session_index"
	args := []any{}
	if options.provider != "" {
		query += " WHERE provider = ?"
		args = append(args, options.provider)
	}
	query += " ORDER BY updated_at_ms DESC"
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, err
	}
	defer rows.Close()
	byID := map[string]resumeSession{}
	for rows.Next() {
		var provider, projectPath, projectDirName, sessionID, title string
		var updatedAt int64
		if err := rows.Scan(&provider, &projectPath, &projectDirName, &sessionID, &title, &updatedAt); err != nil {
			return nil, err
		}
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		existing, exists := byID[sessionID]
		if !exists || resumePriority(provider) < resumePriority(existing.Provider) {
			byID[sessionID] = resumeSession{
				ID: sessionID, Provider: provider, Title: strings.TrimSpace(title),
				ProjectPath: strings.TrimSpace(projectPath), ProjectDirName: strings.TrimSpace(projectDirName),
				UpdatedAt: updatedAt,
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sessions := make([]resumeSession, 0, len(byID))
	for _, session := range byID {
		if options.query != "" {
			needle := strings.ToLower(options.query)
			if !strings.Contains(strings.ToLower(session.ID), needle) &&
				!strings.Contains(strings.ToLower(session.Title), needle) &&
				!strings.Contains(strings.ToLower(session.Provider), needle) {
				continue
			}
		}
		sessions = append(sessions, session)
	}
	cwd, _ := os.Getwd()
	sort.SliceStable(sessions, func(left, right int) bool {
		leftHere := sameResumePath(sessions[left].ProjectPath, cwd)
		rightHere := sameResumePath(sessions[right].ProjectPath, cwd)
		if leftHere != rightHere {
			return leftHere
		}
		return sessions[left].UpdatedAt > sessions[right].UpdatedAt
	})
	if options.limit > 0 && len(sessions) > options.limit {
		sessions = sessions[:options.limit]
	}
	return sessions, nil
}

func resumePriority(provider string) int {
	for index, candidate := range resumeProviderPriority {
		if candidate == provider {
			return index
		}
	}
	return len(resumeProviderPriority)
}

func sameResumePath(left, right string) bool {
	return strings.TrimRight(filepath.Clean(left), "/") == strings.TrimRight(filepath.Clean(right), "/")
}

func formatResumeList(sessions []resumeSession, cwd string) string {
	lines := make([]string, 0, len(sessions)*2)
	for index, session := range sessions {
		marker := " "
		if sameResumePath(session.ProjectPath, cwd) {
			marker = "◆"
		}
		title := session.Title
		if title == "" {
			title = "(无标题)"
		}
		when := formatResumeRelativeTime(session.UpdatedAt)
		line := fmt.Sprintf("%2d %s %-10s %s", index+1, marker, session.Provider, title)
		if when != "" {
			line += "  · " + when
		}
		lines = append(lines, line)
		lines = append(lines, "     "+session.ID+"  "+session.ProjectPath)
	}
	return strings.Join(lines, "\n")
}

func formatResumeRelativeTime(updatedAt int64) string {
	if updatedAt <= 0 {
		return ""
	}
	diff := time.Now().UnixMilli() - updatedAt
	if diff < 0 {
		return "刚刚"
	}
	minute := int64(60 * 1000)
	hour := 60 * minute
	day := 24 * hour
	switch {
	case diff < minute:
		return "刚刚"
	case diff < hour:
		return fmt.Sprintf("%d 分钟前", diff/minute)
	case diff < day:
		return fmt.Sprintf("%d 小时前", diff/hour)
	case diff < 7*day:
		return fmt.Sprintf("%d 天前", diff/day)
	default:
		return time.UnixMilli(updatedAt).Format("2006-01-02")
	}
}

func pickResumeSession(sessions []resumeSession, answer string) *resumeSession {
	if len(sessions) == 0 {
		return nil
	}
	text := strings.TrimSpace(answer)
	if text == "" {
		return &sessions[0]
	}
	if index, err := strconv.Atoi(text); err == nil {
		if index > 0 && index <= len(sessions) {
			return &sessions[index-1]
		}
		return nil
	}
	lower := strings.ToLower(text)
	for index := range sessions {
		if sessions[index].ID == text {
			return &sessions[index]
		}
	}
	for index := range sessions {
		if strings.HasPrefix(strings.ToLower(sessions[index].ID), lower) {
			return &sessions[index]
		}
	}
	for index := range sessions {
		if strings.Contains(strings.ToLower(sessions[index].Title), lower) {
			return &sessions[index]
		}
	}
	return nil
}

func writeResumeHelp(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "aih resume — 跨 provider 选择一段会话并续聊")
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprintln(runtime.stdout, "用法：")
	_, _ = fmt.Fprintln(runtime.stdout, "  aih resume                    列出最近会话（当前目录的项目排前面）")
	_, _ = fmt.Fprintln(runtime.stdout, "  aih resume <关键词>           按标题 / id 片段过滤")
	_, _ = fmt.Fprintln(runtime.stdout, "  aih resume --provider codex   只看某个 provider")
	_, _ = fmt.Fprintln(runtime.stdout, "  aih resume --account 2        指定账号（默认账号可续聊任意会话）")
	_, _ = fmt.Fprintln(runtime.stdout, "  aih resume --json             只输出候选，不启动（给脚本用）")
	_, _ = fmt.Fprintln(runtime.stdout)
	_, _ = fmt.Fprintln(runtime.stdout, "选择方式：输入编号 / id 前缀 / 关键词后回车；直接回车取第一条；q 退出。")
}
