package main

import (
	"context"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/sessionscan/codexindex"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// resolvedCandidate 是原生会话库提供给持久会话行的候选（标题/ID/更新时间）。
type resolvedCandidate struct {
	ID          string
	Title       string
	UpdatedAtMS int64
	ParentID    string
	Subagent    bool
	AgentName   string
	Exec        bool
}

// resolveSessionTitles 用 Provider 原生会话库补标题与原生会话 id（aih ss --refresh）。
//
// 与 Node session-title-resolver 同思路：按项目路径 + 最近活动时间匹配，每个原生
// 会话只认领一行；标题不可用时保留 pane 标题。Codex 没有项目库，单独扫描 rollout。
func resolveSessionTitles(
	ctx context.Context,
	runtime commandRuntime,
	rows []persistent.SessionRow,
) {
	if len(rows) == 0 {
		return
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return
	}
	hostHomeDir := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHomeDir == "" {
		hostHomeDir, _ = runtime.userHomeDir()
	}
	byProvider := make(map[string][]int)
	for index := range rows {
		byProvider[rows[index].Provider] = append(byProvider[rows[index].Provider], index)
	}
	for providerID, indexes := range byProvider {
		candidatesByPath := sessionCandidates(ctx, providerID, aiHomeDir, hostHomeDir)
		if len(candidatesByPath) == 0 {
			continue
		}
		claimed := make(map[string]bool)
		// 先按活动时间排序，让最活跃的行先认领最近的会话。
		sort.SliceStable(indexes, func(left, right int) bool {
			return sessionActivityMillis(rows[indexes[left]]) > sessionActivityMillis(rows[indexes[right]])
		})
		for _, index := range indexes {
			projectKey := normalizeSessionProjectPath(rows[index].Path)
			candidates := candidatesByPath[projectKey]
			if projectKey == "" || len(candidates) == 0 {
				continue
			}
			best := -1
			bestDelta := int64(1<<62 - 1)
			for candidateIndex, candidate := range candidates {
				if claimed[candidate.ID] {
					continue
				}
				delta := absInt64(candidate.UpdatedAtMS - sessionActivityMillis(rows[index]))
				if delta < bestDelta {
					bestDelta = delta
					best = candidateIndex
				}
			}
			if best < 0 {
				continue
			}
			candidate := candidates[best]
			claimed[candidate.ID] = true
			if strings.TrimSpace(rows[index].NativeID) == "" {
				rows[index].NativeID = strings.TrimSpace(candidate.ID)
			}
			if title := usableSessionTitle(candidate.Title); title != "" {
				current := strings.TrimSpace(rows[index].Label)
				if current == "" || len([]rune(current)) > 60 || current == strings.TrimSpace(rows[index].Name) {
					rows[index].Label = title
				}
			}
		}
	}
}

// sessionCandidates 按项目路径组织某个 Provider 的原生会话；不支持读取时返回空。
func sessionCandidates(
	ctx context.Context,
	providerID string,
	aiHomeDir string,
	hostHomeDir string,
) map[string][]resolvedCandidate {
	byPath := make(map[string][]resolvedCandidate)
	if providerID == "codex" {
		for _, session := range codexindex.List(hostHomeDir) {
			key := normalizeSessionProjectPath(session.CWD)
			if key == "" {
				continue
			}
			byPath[key] = append(byPath[key], resolvedCandidate{
				ID:          session.ID,
				Title:       session.Title,
				UpdatedAtMS: session.UpdatedAtMS,
			})
		}
		return byPath
	}
	projects, err := sessionread.ListProjects(ctx, sessionread.Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
	}, providerID)
	if err != nil {
		return byPath
	}
	for _, project := range projects {
		key := normalizeSessionProjectPath(project.Path)
		if key == "" {
			continue
		}
		for _, session := range project.Sessions {
			byPath[key] = append(byPath[key], resolvedCandidate{
				ID:          session.ID,
				Title:       session.Title,
				UpdatedAtMS: sessionUpdatedMillis(session),
			})
		}
	}
	return byPath
}

// normalizeSessionProjectPath 统一路径分隔符与尾斜杠。
func normalizeSessionProjectPath(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	return filepath.Clean(text)
}

// sessionUpdatedMillis 把会话更新时间归一成毫秒（不同 Provider 可能给秒）。
func sessionUpdatedMillis(session sessionread.Session) int64 {
	value := session.UpdatedAt
	if value > 0 && value < 1_000_000_000_000 {
		return value * 1000
	}
	return value
}

// usableSessionTitle 过滤合成上下文与占位标题（与 Node isUsableTitle 的核心规则一致）。
func usableSessionTitle(value string) string {
	title := compactSessionTitle(value)
	if title == "" || title == "Warmup" || title == "未命名会话" {
		return ""
	}
	for _, prefix := range []string{
		"A session-scoped Stop hook is now active",
		"Briefly acknowledge the goal",
		"<goal_context", "<environment_context", "<user_instructions",
		"<session_context", "# AGENTS.md instructions", "Caveat:", "<command-name>",
		"<command-args>", "<local-command-stdout", "<local-command-stderr",
		"<system-reminder", "<codex_internal_context", "<turn_aborted", "<user_shell_command",
	} {
		if strings.HasPrefix(title, prefix) {
			return ""
		}
	}
	return title
}

// compactSessionTitle 把标题压成一行并限制显示长度。会话标题来自用户首条
// 消息时常常是一大段粘贴内容；直接放进选择器会把整屏撑乱。
func compactSessionTitle(value string) string {
	text := strings.TrimSpace(sanitizeTerminalText(value))
	if index := strings.IndexAny(text, "\r\n"); index >= 0 {
		text = strings.TrimSpace(text[:index])
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return ""
	}
	const maxRunes = 72
	runes := []rune(text)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes-1]) + "…"
	}
	return text
}

// displaySessionTitle 返回列表/选择器里真正展示的标题。
func displaySessionTitle(row persistent.SessionRow) string {
	for _, candidate := range []string{row.Label, row.Title, row.WindowName} {
		if title := usableSessionTitle(candidate); title != "" {
			return title
		}
	}
	if id := strings.TrimSpace(row.NativeID); id != "" {
		return row.Provider + "-" + shortSessionID(id)
	}
	if name := strings.TrimSpace(row.Name); name != "" {
		return name
	}
	return "-"
}

// ensureUniqueSessionTitles 给同项目下标题相同的行补一个会话身份后缀。
// Provider 的自动标题可能重复（例如同一批 goal 文本），没有后缀时用户
// 无法在列表里区分到底哪一行是哪个会话。
func ensureUniqueSessionTitles(rows []persistent.SessionRow) {
	if len(rows) < 2 {
		return
	}
	titles := make([]string, len(rows))
	counts := make(map[string]int, len(rows))
	for index := range rows {
		titles[index] = displaySessionTitle(rows[index])
		counts[sessionTitleKey(rows[index], titles[index])]++
	}
	seen := make(map[string]int, len(rows))
	for index := range rows {
		key := sessionTitleKey(rows[index], titles[index])
		rows[index].Label = titles[index]
		if counts[key] <= 1 {
			continue
		}
		seen[key]++
		if seen[key] == 1 {
			continue
		}
		rows[index].Label = titles[index] + " · " + sessionTitleSuffix(rows[index], seen[key])
	}
}

func sessionTitleKey(row persistent.SessionRow, title string) string {
	project := strings.TrimSpace(row.Path)
	if project == "" {
		project = strings.TrimSpace(row.StartPath)
	}
	return strings.ToLower(strings.TrimSpace(row.Provider)) + "\x00" + project + "\x00" + strings.ToLower(strings.TrimSpace(title))
}

func sessionTitleSuffix(row persistent.SessionRow, duplicateIndex int) string {
	if id := strings.TrimSpace(row.NativeID); id != "" {
		return shortSessionID(id)
	}
	if name := strings.TrimSpace(row.Name); name != "" {
		return name
	}
	return strconv.Itoa(duplicateIndex)
}

// sanitizeTerminalText 去掉用户消息里的控制字符，避免 transcript 内容
// 把 ANSI/光标控制序列注入到列表里。
func sanitizeTerminalText(value string) string {
	return strings.Map(func(char rune) rune {
		switch char {
		case '\t', '\n', '\r':
			return ' '
		}
		if char < 0x20 || char == 0x7f {
			return -1
		}
		return char
	}, value)
}

// mainSessionRows 用于非交互列表：subagent 默认折叠，不单独占一行。
// 交互 picker 仍保留它们，只是默认不进入 visibleRows。
// foldedSessionTitle 给有 subagent 的主行加折叠标记，非交互列表也能看出
// 这一行下面还有隐藏会话；没有子会话时保持原标题。
func foldedSessionTitle(rows []persistent.SessionRow, row persistent.SessionRow) string {
	for _, candidate := range rows {
		if candidate.Subagent && strings.TrimSpace(candidate.ParentID) == strings.TrimSpace(row.NativeID) {
			return "▸ " + globalSessionTitle(row)
		}
	}
	return globalSessionTitle(row)
}

func mainSessionRows(rows []persistent.SessionRow) []persistent.SessionRow {
	selected := make([]persistent.SessionRow, 0, len(rows))
	for _, row := range rows {
		if row.Subagent || row.Origin == persistent.SessionOriginExternalCodex {
			continue
		}
		selected = append(selected, row)
	}
	return selected
}

func sessionOriginLabel(row persistent.SessionRow) string {
	switch row.Origin {
	case persistent.SessionOriginTmux:
		return "tmux"
	case persistent.SessionOriginAIHNative:
		return "aih-native"
	case persistent.SessionOriginAIHEnded:
		return "aih-ended"
	case persistent.SessionOriginExternalCodex:
		return "external-codex"
	}
	if strings.TrimSpace(row.Socket) != "" {
		return "tmux"
	}
	if row.NativeOnly {
		return "aih-native"
	}
	return "-"
}

func filterExternalSessionRows(rows []persistent.SessionRow) []persistent.SessionRow {
	selected := make([]persistent.SessionRow, 0, len(rows))
	for _, row := range rows {
		if row.Origin == persistent.SessionOriginExternalCodex {
			continue
		}
		selected = append(selected, row)
	}
	return selected
}

func shortSessionID(id string) string {
	text := strings.TrimSpace(id)
	if len(text) <= 8 {
		return text
	}
	return text[len(text)-8:]
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
