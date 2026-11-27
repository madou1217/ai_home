package completion

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
)

// listAppCandidates 与 alt+space 工作台同源：同一个 appcatalog 扫描、同一套
// 别名与 frecency 排序。仅用于 `aih app <TAB>` 的参数位。
func listAppCandidates(aiHome string) []namedChoice {
	store, err := launcherstore.New(aiHome)
	if err != nil {
		return nil
	}
	catalog := appcatalog.NewWithOptions(appcatalog.Options{CachePath: appcatalog.CachePath(aiHome)})
	service, err := launcher.NewService(catalog, applaunch.New(), store, time.Now)
	if err != nil {
		return nil
	}
	result, err := service.List(context.Background(), launcher.ListOptions{})
	if err != nil {
		return nil
	}
	choices := make([]namedChoice, 0, len(result.Apps))
	for _, app := range result.Apps {
		mode := applaunch.ProxyModeFor(app)
		description := string(app.Kind) + " · 代理:" + mode.Label() + " · " + app.Subtitle
		choices = append(choices, namedChoice{Value: app.Name, Description: description})
		for _, alias := range app.Aliases {
			if alias == "" || alias == app.Name {
				continue
			}
			choices = append(choices, namedChoice{Value: alias, Description: "别名 · " + description})
		}
	}
	return choices
}
