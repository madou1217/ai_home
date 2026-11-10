package webuisessionslistapi

import "sort"

// finalizeProjects 统一排序并补齐空数组，保证响应形状稳定：
//
//   - 会话按 updatedAt 降序（Node 的读取器在项目内就是这样排序的）；
//   - 空 id 的会话不下发（Node sanitizeProjectSessions 同口径）；
//   - 项目按最近活动降序，时间相同时按路径升序，避免宿主目录遍历顺序泄漏到响应里。
//
// Node 这个接口按读取器的自然顺序返回项目（claude 是目录名序、codex 是文件序），
// 这里统一成与 webuiprojectsapi 相同的「最近活动优先」，前端不需要再排一次。
func finalizeProjects(projects []projectView) []projectView {
	finalized := make([]projectView, 0, len(projects))
	for _, project := range projects {
		sessions := make([]sessionView, 0, len(project.Sessions))
		for _, session := range project.Sessions {
			if trimSpace(session.ID) == "" {
				continue
			}
			sessions = append(sessions, session)
		}
		if len(sessions) == 0 {
			continue
		}
		sort.SliceStable(sessions, func(left, right int) bool {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		})
		project.Sessions = sessions
		finalized = append(finalized, project)
	}

	sort.SliceStable(finalized, func(left, right int) bool {
		leftActivity := projectLastActivityAt(finalized[left])
		rightActivity := projectLastActivityAt(finalized[right])
		if leftActivity != rightActivity {
			return leftActivity > rightActivity
		}
		return finalized[left].Path < finalized[right].Path
	})
	return finalized
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
