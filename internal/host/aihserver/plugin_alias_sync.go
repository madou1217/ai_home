package aihserver

import (
	"strings"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
)

// installPluginAliasSync 把插件运行时声明的模型别名注入 Go 路由别名投影。
// 插件代次变化时整体替换；别名不落库，插件停用后自动消失。
func installPluginAliasSync(store *modelalias.Store, service *pluginhost.Service, onChange func()) {
	if store == nil || service == nil || service.Runtime() == nil {
		return
	}
	refresh := func() {
		aliases := service.CatalogAliases()
		records := make([]modelalias.Record, 0, len(aliases))
		enabled := true
		for index, item := range aliases {
			alias := strings.TrimSpace(item.Alias)
			target := strings.TrimSpace(item.Target)
			if alias == "" || target == "" {
				continue
			}
			records = append(records, modelalias.Record{
				ID:             "plugin:" + strings.TrimSpace(item.InstanceID) + ":" + alias,
				Alias:          alias,
				Target:         target,
				Provider:       modelalias.ScopeAll,
				TargetProvider: modelalias.TargetProviderAuto,
				Priority:       int32(index),
				Enabled:        &enabled,
				Description:    strings.TrimSpace(item.Description),
			})
		}
		_ = store.SetVolatile(records)
		if onChange != nil {
			onChange()
		}
	}
	service.Runtime().SetOnRuntimeChange(refresh)
	refresh()
}
