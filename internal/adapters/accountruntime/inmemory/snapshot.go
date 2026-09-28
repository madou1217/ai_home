package inmemory

import (
	"sort"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// blockTriggerOrder 固定输出顺序，保证快照稳定（Node 用它计算推送签名）。
var blockTriggerOrder = []struct {
	block   blockSet
	trigger runtimecore.RecoveryTrigger
}{
	{blockCredentialsUpdated, runtimecore.RecoveryCredentialsUpdated},
	{blockUsageSnapshot, runtimecore.RecoveryUsageSnapshot},
	{blockBillingSnapshot, runtimecore.RecoveryBillingSnapshot},
	{blockAccountStatus, runtimecore.RecoveryAccountStatus},
	{blockModelCatalog, runtimecore.RecoveryModelCatalog},
	{blockPolicySnapshot, runtimecore.RecoveryPolicySnapshot},
}

// triggers 把紧凑位集合展开为恢复事件列表。
func (set blockSet) triggers() []runtimecore.RecoveryTrigger {
	var triggers []runtimecore.RecoveryTrigger
	for _, entry := range blockTriggerOrder {
		if set&entry.block != 0 {
			triggers = append(triggers, entry.trigger)
		}
	}
	return triggers
}

// RuntimeSnapshot 返回全部硬阻塞与仍生效 cooldown 的只读投影，按账号、模型排序。
// 健康账号不出现；只读，不回收过期状态。
func (runtime *Runtime) RuntimeSnapshot() []runtimeapp.AccountView {
	cooldowns := runtime.cooldowns.ActiveCooldowns()

	runtime.mu.RLock()
	views := make(map[accountcore.AccountRef]*runtimeapp.AccountView)
	view := func(accountRef accountcore.AccountRef) *runtimeapp.AccountView {
		if existing, found := views[accountRef]; found {
			return existing
		}
		created := &runtimeapp.AccountView{AccountRef: accountRef}
		views[accountRef] = created
		return created
	}
	models := make(map[runtimecore.ModelRoute]*runtimeapp.ModelView)
	model := func(route runtimecore.ModelRoute) *runtimeapp.ModelView {
		if existing, found := models[route]; found {
			return existing
		}
		created := &runtimeapp.ModelView{Model: route.ModelID()}
		models[route] = created
		return created
	}
	for accountRef, blocks := range runtime.accountBlocks {
		if triggers := blocks.triggers(); len(triggers) > 0 {
			view(accountRef).Blocks = triggers
		}
	}
	for route, blocks := range runtime.modelBlocks {
		if triggers := blocks.triggers(); len(triggers) > 0 {
			model(route).Blocks = triggers
		}
	}
	runtime.mu.RUnlock()

	for _, cooldown := range cooldowns {
		entry := model(cooldown.Route)
		entry.CooldownKind = cooldown.Kind
		entry.CooldownUntil = cooldown.Until
	}
	for route, entry := range models {
		account := view(route.AccountRef())
		account.Models = append(account.Models, *entry)
	}

	result := make([]runtimeapp.AccountView, 0, len(views))
	for _, entry := range views {
		sort.Slice(entry.Models, func(left, right int) bool {
			return entry.Models[left].Model < entry.Models[right].Model
		})
		result = append(result, *entry)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].AccountRef.String() < result[right].AccountRef.String()
	})
	return result
}
