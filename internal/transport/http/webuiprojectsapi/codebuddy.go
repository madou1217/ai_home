package webuiprojectsapi

import (
	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

// codebuddyProjects 读取该 Provider 所属地区的全部项目与会话。
//
// 解析与去重逻辑在 internal/sessionscan/codebuddy（与 webuisessionslistapi 共用），
// 这里只做扫描预算适配与形状转换。
func (scan *scanner) codebuddyProjects(provider string) []rawProject {
	projects := codebuddy.ReadProjects(scan.hostHome, provider, scan)
	raw := make([]rawProject, 0, len(projects))
	for _, project := range projects {
		sessions := make([]rawSession, 0, len(project.Sessions))
		for _, session := range project.Sessions {
			sessions = append(sessions, rawSession{
				ID:             session.ID,
				Title:          session.Title,
				UpdatedAt:      session.UpdatedAt,
				Provider:       session.Provider,
				ProjectDirName: session.ProjectDirName,
			})
		}
		raw = append(raw, rawProject{
			ID:       project.ID,
			Name:     project.Name,
			Path:     project.Path,
			Provider: project.Provider,
			Sessions: sessions,
		})
	}
	return raw
}
