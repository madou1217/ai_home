// Package modelvisibility 把客户端 Key 的账号池/模型池折算成模型目录的可见集合。
//
// 目录接口（/v1/models）必须与路由层使用同一套白名单语义：模型池为空表示不
// 限制，账号池为空表示不限制 Provider；请求别名时「别名本身或其解析目标」任一
// 命中模型池即允许（与 application/inferencegateway.ScopedRoutes 一致）。
// 本包只做纯计算，输入是已认证 Key 的限制与当前路由行，不读数据库、HTTP 或配置。
package modelvisibility

import (
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/core/clientkeys"
)

// Scope 是一次目录可见性判定的白名单；零值表示不受限。
type Scope struct {
	restricted bool
	providers  map[string]struct{}
	models     map[string]struct{}
}

// FromLimits 把已认证 Key 的生效限制折算成目录作用域。
func FromLimits(limits clientkeys.Limits) Scope {
	if !limits.Restricted() {
		return Scope{}
	}
	return Scope{
		restricted: true,
		providers:  toSet(limits.AllowedProviders),
		models:     toSet(limits.AllowedModels),
	}
}

// Restricted 报告这把 Key 是否配置了账号池或模型池。
func (scope Scope) Restricted() bool {
	return scope.restricted
}

// Result 是一次作用域判定的结果。
type Result struct {
	// Routable 是通过账号池与模型池白名单的路由行；顺序与输入一致。
	// 它直接交给模型视图渲染，保证 supported_endpoints 只汇总允许的 Provider。
	Routable []accountapp.RoutableModel
	// VisibleIDs 是目录允许展示的 ID：通过白名单的具体模型，以及允许的别名。
	VisibleIDs map[string]struct{}
}

// Apply 过滤路由行并计算目录可见 ID。
//
// routable 为当前可路由模型行（可能同一模型被多家 Provider 提供），aliases 为
// 已编译的可展示别名。调用方应先确认 scope.Restricted()，未受限时本方法返回零值。
func (scope Scope) Apply(
	routable []accountapp.RoutableModel,
	aliases []modelalias.DisplayModel,
) Result {
	if !scope.restricted {
		return Result{}
	}
	result := Result{
		Routable:   make([]accountapp.RoutableModel, 0, len(routable)),
		VisibleIDs: make(map[string]struct{}, len(routable)),
	}
	// providerRoutable 记录「至少有一条允许 Provider 路由」的模型 ID。
	// 别名目标可能不在模型池里（模型池命中的是别名本身），但仍需确认它确实
	// 能经由允许的账号池调度，否则别名不可用、不应出现在目录里。
	providerRoutable := make(map[string]struct{}, len(routable))
	for _, model := range routable {
		if !model.IsValid() {
			continue
		}
		if !scope.allowsProvider(string(model.ProviderID())) {
			continue
		}
		modelID := model.ModelID().String()
		providerRoutable[modelID] = struct{}{}
		if !scope.allowsModel(modelID) {
			continue
		}
		result.Routable = append(result.Routable, model)
		result.VisibleIDs[modelID] = struct{}{}
	}
	for _, alias := range aliases {
		if strings.TrimSpace(alias.Alias) == "" || strings.TrimSpace(alias.Target) == "" {
			continue
		}
		if !scope.allowsModel(alias.Alias) && !scope.allowsModel(alias.Target) {
			continue
		}
		if !scope.aliasProviderAllowed(alias, providerRoutable) {
			continue
		}
		result.VisibleIDs[alias.Alias] = struct{}{}
	}
	return result
}

// aliasProviderAllowed 判断别名的目标是否能经由允许的账号池调度。
//
// 别名编译结果里 Provider 只在「显式 targetProvider 或目标只有一家 Provider」
// 时才有值；为空表示目标由多家 Provider 承载，此时按目标模型是否有允许 Provider
// 的路由行判定。
func (scope Scope) aliasProviderAllowed(
	alias modelalias.DisplayModel,
	providerRoutable map[string]struct{},
) bool {
	if len(scope.providers) == 0 {
		return true
	}
	if providerID := strings.TrimSpace(alias.Provider); providerID != "" {
		return scope.allowsProvider(providerID)
	}
	_, ok := providerRoutable[strings.TrimSpace(alias.Target)]
	return ok
}

func (scope Scope) allowsProvider(providerID string) bool {
	if len(scope.providers) == 0 {
		return true
	}
	_, ok := scope.providers[strings.TrimSpace(providerID)]
	return ok
}

func (scope Scope) allowsModel(modelID string) bool {
	if len(scope.models) == 0 {
		return true
	}
	_, ok := scope.models[strings.TrimSpace(modelID)]
	return ok
}

func toSet(values []string) map[string]struct{} {
	if len(values) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			set[trimmed] = struct{}{}
		}
	}
	if len(set) == 0 {
		return nil
	}
	return set
}