package webuisessionslistapi

import (
	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

// codebuddyProjects 读取该 Provider 所属地区的全部项目与会话。
//
// 解析与去重逻辑在 internal/sessionscan/codebuddy（与 webuiprojectsapi 共用），
// 这里只做扫描预算适配与形状转换。
func (scan *scanner) codebuddyProjects(provider string) []projectView {
	projects := codebuddy.ReadProjects(scan.hostHome, provider, scan)
	views := make([]projectView, 0, len(projects))
	for _, project := range projects {
		sessions := make([]sessionView, 0, len(project.Sessions))
		for _, session := range project.Sessions {
			sessions = append(sessions, sessionView{
				ID:             session.ID,
				Title:          session.Title,
				UpdatedAt:      session.UpdatedAt,
				Provider:       session.Provider,
				ProjectDirName: session.ProjectDirName,
			})
		}
		views = append(views, projectView{
			ID:       project.ID,
			Name:     project.Name,
			Path:     project.Path,
			Sessions: sessions,
			Provider: project.Provider,
		})
	}
	return views
}

// Take 实现 codebuddy.Budget：消费一个目录条目预算。
func (scan *scanner) Take() bool {
	return scan.take()
}

// OutOfTime 实现 codebuddy.Budget：只检查时限。
func (scan *scanner) OutOfTime() bool {
	return scan.outOfTime()
}
