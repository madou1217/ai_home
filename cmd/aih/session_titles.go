package main

import (
	"context"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// resolveSessionTitles 用 Provider 原生会话库补标题与原生会话 id（aih ss --refresh）。
//
// 与 Node session-title-resolver 同思路：按项目路径 + 最近活动时间匹配，每个原生
// 会话只认领一行；标题不可用时保留 pane 标题。
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
		projects, listErr := sessionread.ListProjects(ctx, sessionread.Options{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
		}, providerID)
		if listErr != nil || len(projects) == 0 {
			continue
		}
		byPath := make(map[string][]sessionread.Session)
		for _, project := range projects {
			key := normalizeSessionProjectPath(project.Path)
			if key == "" {
				continue
			}
			byPath[key] = append(byPath[key], project.Sessions...)
		}
		claimed := make(map[string]bool)
		// 先按活动时间排序，让最活跃的行先认领最近的会话。
		sort.SliceStable(indexes, func(left, right int) bool {
			return sessionActivityMillis(rows[indexes[left]]) > sessionActivityMillis(rows[indexes[right]])
		})
		for _, index := range indexes {
			projectKey := normalizeSessionProjectPath(rows[index].Path)
			candidates := byPath[projectKey]
			if projectKey == "" || len(candidates) == 0 {
				continue
			}
			best := -1
			bestDelta := int64(1<<62 - 1)
			for candidateIndex, candidate := range candidates {
				if claimed[candidate.ID] {
					continue
				}
				delta := absInt64(sessionUpdatedMillis(candidate) - sessionActivityMillis(rows[index]))
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

// normalizeSessionProjectPath 统一路径分隔符与大小写边界（macOS 大小写不敏感）。
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
	title := strings.Join(strings.Fields(value), " ")
	if title == "" || title == "Warmup" || title == "未命名会话" {
		return ""
	}
	for _, prefix := range []string{
		"<goal_context", "<environment_context", "<user_instructions",
		"<session_context", "# AGENTS.md instructions", "Caveat:", "<command-name>",
	} {
		if strings.HasPrefix(title, prefix) {
			return ""
		}
	}
	if len([]rune(title)) > 120 {
		title = string([]rune(title)[:120])
	}
	return title
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
