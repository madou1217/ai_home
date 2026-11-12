package webuiprojectsapi

import (
	"encoding/base64"
	"path/filepath"
	"sort"
	"strings"
)

// base64StdEncoding 是 Node Buffer 默认的 base64 字母表（codex / opencode 项目 id 用）。
var base64StdEncoding = base64.StdEncoding

// base64PathID 复刻 Node 的项目 id 派生：prefix + base64(value)，再把 / + = 折成下划线。
func base64PathID(prefix, value string) string {
	encoded := base64StdEncoding.EncodeToString([]byte(value))
	return prefix + strings.NewReplacer("/", "_", "+", "_", "=", "_").Replace(encoded)
}

// base64URLPathID 复刻 Node 的 Buffer.toString('base64url')（cline 项目 id 用）。
func base64URLPathID(prefix, value string) string {
	return prefix + base64.RawURLEncoding.EncodeToString([]byte(value))
}

func trimSpace(value string) string {
	return strings.TrimSpace(value)
}

// compactWhitespace 等价于 JS 的 replace(/\s+/g, ' ').trim()。
func compactWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// normalizeProjectPath 等价于 Node 的 normalizeProjectPath：去空白并去掉尾部斜杠。
func normalizeProjectPath(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

// aggregateOptions 控制一次聚合的范围与截断。
type aggregateOptions struct {
	// projectPath 非空时只保留归一化后等于该路径的项目（单项目全量读）。
	projectPath string
	// includeAllSessions 为 true 时不套 sessionPayloadCap，下发完整会话集合。
	includeAllSessions bool
}

// aggregateProjects 按项目路径聚合，复刻 Node buildProjectsSnapshot 的口径：
//
//   - 同一路径的多个 Provider 合并成一个项目，providers 按首次出现顺序；
//   - 同一会话 id 只保留一份，更新的副本覆盖标题与时间，但保留先遇到的
//     Provider 与目录身份（CodeBuddy 家族两个 Provider 会读出同一批会话）；
//   - 项目内会话按 updatedAt 降序，项目间按最近活动降序；
//   - 默认每个项目最多下发 sessionPayloadCap 条会话，总量用 sessionTotal 表达；
//     includeAllSessions 时下发全部会话。
//
// 路径在磁盘上不存在的项目直接丢弃（与 Node filterHiddenProjects 同口径）。
func aggregateProjects(raw []rawProject, pathExists func(string) bool, options aggregateOptions) []projectView {
	projects := make([]projectView, 0, len(raw))
	projectIndexByPath := make(map[string]int, len(raw))
	sessionIndexByPath := make(map[string]map[string]int, len(raw))

	for _, project := range raw {
		projectPath := normalizeProjectPath(project.Path)
		if projectPath == "" || !pathExists(projectPath) {
			continue
		}
		if options.projectPath != "" && projectPath != options.projectPath {
			continue
		}
		position, exists := projectIndexByPath[projectPath]
		if !exists {
			position = len(projects)
			projectIndexByPath[projectPath] = position
			projects = append(projects, projectView{
				ID:        project.ID,
				Name:      project.Name,
				Path:      projectPath,
				Providers: []string{project.Provider},
				Sessions:  []sessionView{},
			})
			sessionIndexByPath[projectPath] = make(map[string]int, len(project.Sessions))
		} else if !containsString(projects[position].Providers, project.Provider) {
			projects[position].Providers = append(projects[position].Providers, project.Provider)
		}

		target := &projects[position]
		sessionIndex := sessionIndexByPath[projectPath]
		for _, session := range project.Sessions {
			sessionID := trimSpace(session.ID)
			if sessionID == "" {
				continue
			}
			dirName := session.ProjectDirName
			if dirName == "" {
				// Node: projectDirName: session.projectDirName || project.id
				dirName = project.ID
			}
			incoming := sessionView{
				ID:             sessionID,
				Title:          session.Title,
				UpdatedAt:      session.UpdatedAt,
				Provider:       project.Provider,
				ProjectDirName: dirName,
				ProjectPath:    projectPath,
			}
			if index, seen := sessionIndex[sessionID]; seen {
				target.Sessions[index] = mergeProjectSession(target.Sessions[index], incoming)
				continue
			}
			sessionIndex[sessionID] = len(target.Sessions)
			target.Sessions = append(target.Sessions, incoming)
		}
	}

	for index := range projects {
		sessions := projects[index].Sessions
		sort.SliceStable(sessions, func(left, right int) bool {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		})
		projects[index].SessionTotal = len(sessions)
		if !options.includeAllSessions && len(sessions) > sessionPayloadCap {
			projects[index].Sessions = sessions[:sessionPayloadCap]
		}
	}

	sort.SliceStable(projects, func(left, right int) bool {
		return projectLastActivityAt(projects[left]) > projectLastActivityAt(projects[right])
	})
	return projects
}

// filterChatWorkspaceProjects 去掉 aih 内部 chat 工作区下的项目。
//
// 这些目录是 aih 为网页会话临时建的工作目录（<aiHomeDir>/run/chat-workspaces/<hash>），
// 不属于用户项目；Node 的 filterHiddenProjects 同样把它们排除。
func filterChatWorkspaceProjects(projects []rawProject, aiHomeDir string) []rawProject {
	chatWorkspacesRoot := normalizeProjectPath(filepath.Join(aiHomeDir, "run", "chat-workspaces"))
	if chatWorkspacesRoot == "" {
		return projects
	}
	filtered := make([]rawProject, 0, len(projects))
	for _, project := range projects {
		projectPath := normalizeProjectPath(project.Path)
		if projectPath == chatWorkspacesRoot ||
			strings.HasPrefix(projectPath, chatWorkspacesRoot+"/") {
			continue
		}
		filtered = append(filtered, project)
	}
	return filtered
}

// mergeProjectSession 只在副本更新时覆盖标题与时间，Provider 与目录身份始终保留
// 先遇到的那一份，避免旧副本把刚续聊产生的新时间顶掉。
func mergeProjectSession(existing, incoming sessionView) sessionView {
	if incoming.UpdatedAt <= existing.UpdatedAt {
		return existing
	}
	existing.Title = incoming.Title
	existing.UpdatedAt = incoming.UpdatedAt
	return existing
}

// projectLastActivityAt 是项目内最新的会话时间；没有会话时为 0。
func projectLastActivityAt(project projectView) int64 {
	latest := int64(0)
	for _, session := range project.Sessions {
		if session.UpdatedAt > latest {
			latest = session.UpdatedAt
		}
	}
	return latest
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
