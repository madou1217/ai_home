package completion

import "github.com/madou1217/ai_home/internal/runtime/appcatalog"

// listAppCandidates 列出本机应用；仅用于 `aih app <TAB>` 的参数位。
func listAppCandidates() []namedChoice {
	apps, err := appcatalog.List()
	if err != nil {
		return nil
	}
	choices := make([]namedChoice, 0, len(apps))
	for _, app := range apps {
		description := app.Path
		if app.Chromium {
			description = "浏览器 · " + description
		}
		choices = append(choices, namedChoice{Value: app.Name, Description: description})
	}
	return choices
}
