package persistent

import (
	"github.com/madou1217/ai_home/internal/runtime/sessionproject"
	"strings"
)

// FilterSessionsByCwd leaves host-wide collection/cache ownership unchanged.
func FilterSessionsByCwd(rows []SessionRow, cwd string) []SessionRow {
	selected := make([]SessionRow, 0, len(rows))
	for _, row := range rows {
		project := strings.TrimSpace(row.Path)
		if project == "" {
			project = row.StartPath
		}
		if sessionproject.MatchesCwd(project, cwd) {
			selected = append(selected, row)
		}
	}
	return selected
}
