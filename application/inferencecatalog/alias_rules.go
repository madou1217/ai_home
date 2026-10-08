package inferencecatalog

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// AliasDropReason 说明一条别名为什么没有被编译成 Go 路由规则。
type AliasDropReason string

const (
	// AliasDropScopeUnsupported 表示别名作用域是 Go 无法表达的客户端 Provider。
	AliasDropScopeUnsupported AliasDropReason = "scope_unsupported"
	// AliasDropTargetNotRoutable 表示别名目标在 Go 账号库里没有可路由的 Provider。
	AliasDropTargetNotRoutable AliasDropReason = "target_not_routable"
	// AliasDropInvalidPattern 表示别名或目标不是合法模型标识。
	AliasDropInvalidPattern AliasDropReason = "invalid_pattern"
)

// AliasDrop 记录一条被丢弃的别名及原因，随管理接口回给 Node。
type AliasDrop struct {
	ID     string          `json:"id"`
	Alias  string          `json:"alias"`
	Reason AliasDropReason `json:"reason"`
}

// AliasCompilation 是别名投影的编译结果。
//
// Generation 是编译时读取的投影代次，Applied 为真表示这份结果已随快照发布；
// AcceptedIDs 只含真正产出路由的别名，Node 据此对未接受的别名继续保守交还。
type AliasCompilation struct {
	Generation  int64
	Rules       []inferencegateway.RouteRule
	AcceptedIDs []string
	Dropped     []AliasDrop
}

// ruleIdentity 是目录内不可重复的规则身份，与 inferencegateway 内部一致。
type ruleIdentity struct {
	pattern        string
	scope          inferencegateway.RouteScope
	providerID     inference.ProviderID
	protocolID     inference.ProtocolID
	effectiveModel string
}

func identityOf(rule inferencegateway.RouteRule) ruleIdentity {
	return ruleIdentity{
		pattern:        rule.Pattern(),
		scope:          rule.Scope(),
		providerID:     rule.Route().ProviderID(),
		protocolID:     rule.Route().ProtocolID(),
		effectiveModel: rule.Route().EffectiveModel(),
	}
}

// aliasScope 把 Node 的别名作用域 Provider 映射为 Go 的客户端协议作用域。
//
// Node 的 provider="all" 对任意客户端生效；codex/claude 分别对应 OpenAI 与
// Anthropic 客户端入口。其余 Provider（gemini、agy、grok…）在 Go 里没有等价
// 客户端作用域，保守丢弃——这些别名继续留在 Node。
func aliasScope(provider string) (inferencegateway.RouteScope, bool) {
	switch provider {
	case "", modelalias.ScopeAll:
		return inferencegateway.RouteScopeAll, true
	case "codex":
		return inferencegateway.RouteScopeCodex, true
	case "claude":
		return inferencegateway.RouteScopeClaude, true
	default:
		return "", false
	}
}

// compileAliases 把 Node 的别名投影编译为路由规则。
//
// 只编译 Go 能忠实执行的别名：作用域可表达、目标模型在本地账号库里可路由。
// 目标 Provider 显式时用它；为 auto 时用所有拥有该目标模型的 Provider。
// 同身份的重复规则按更高 priority 覆盖，保证与 Node 的优先级语义一致。
func (builder *Builder) compileAliases(
	models []accountapp.RoutableModel,
	nativeIdentities map[ruleIdentity]struct{},
) AliasCompilation {
	compilation := AliasCompilation{}
	if builder == nil || builder.aliases == nil {
		return compilation
	}
	projection := builder.aliases.Snapshot()
	compilation.Generation = projection.Generation()
	records := projection.Records()
	if len(records) == 0 {
		return compilation
	}
	providersByModel := make(map[string][]inference.ProviderID)
	for _, model := range models {
		modelID := model.ModelID().String()
		providersByModel[modelID] = append(
			providersByModel[modelID],
			inference.ProviderID(model.ProviderID()),
		)
	}
	seen := make(map[ruleIdentity]int, len(records))
	for _, record := range records {
		if !record.IsEnabled() {
			continue
		}
		scope, scopeOK := aliasScope(record.ScopeProvider())
		if !scopeOK {
			compilation.Dropped = append(compilation.Dropped, AliasDrop{
				ID: record.ID, Alias: record.Alias, Reason: AliasDropScopeUnsupported,
			})
			continue
		}
		targetID, targetErr := runtimecore.NewModelID(record.Target)
		if targetErr != nil {
			compilation.Dropped = append(compilation.Dropped, AliasDrop{
				ID: record.ID, Alias: record.Alias, Reason: AliasDropInvalidPattern,
			})
			continue
		}
		added := 0
		for _, providerID := range aliasTargetProviders(record, providersByModel[targetID.String()]) {
			rule, ok := builder.buildAliasRule(record, scope, providerID, targetID)
			if !ok {
				continue
			}
			identity := identityOf(rule)
			if _, native := nativeIdentities[identity]; native {
				continue
			}
			if index, duplicate := seen[identity]; duplicate {
				if rule.Priority() > compilation.Rules[index].Priority() {
					compilation.Rules[index] = rule
				}
				added++
				continue
			}
			seen[identity] = len(compilation.Rules)
			compilation.Rules = append(compilation.Rules, rule)
			added++
		}
		if added == 0 {
			compilation.Dropped = append(compilation.Dropped, AliasDrop{
				ID: record.ID, Alias: record.Alias, Reason: AliasDropTargetNotRoutable,
			})
			continue
		}
		if record.ID != "" {
			compilation.AcceptedIDs = append(compilation.AcceptedIDs, record.ID)
		}
	}
	return compilation
}

// aliasTargetProviders 选择别名目标要指向的 Provider。
//
// 显式 targetProvider 只接受该 Provider；auto 时用所有拥有该目标模型的 Provider，
// 与 Node 的「按目标模型推导 Provider」一致。
func aliasTargetProviders(
	record modelalias.Record,
	routable []inference.ProviderID,
) []inference.ProviderID {
	explicit := record.ResolvedTargetProvider()
	if explicit == modelalias.TargetProviderAuto {
		return routable
	}
	providerID := inference.ProviderID(explicit)
	if !providerID.IsValid() {
		return nil
	}
	for _, candidate := range routable {
		if candidate == providerID {
			return []inference.ProviderID{providerID}
		}
	}
	return nil
}

// buildAliasRule 用 Provider Factory 为别名目标构造一条规则。
func (builder *Builder) buildAliasRule(
	record modelalias.Record,
	scope inferencegateway.RouteScope,
	providerID inference.ProviderID,
	targetID runtimecore.ModelID,
) (inferencegateway.RouteRule, bool) {
	factory := builder.factories[providerID]
	if factory == nil {
		return inferencegateway.RouteRule{}, false
	}
	route, err := factory.BuildRoute(targetID)
	if err != nil ||
		!route.IsValid() ||
		route.ProviderID() != providerID ||
		route.EffectiveModel() != targetID.String() {
		return inferencegateway.RouteRule{}, false
	}
	rule, err := inferencegateway.NewRouteRule(inferencegateway.RouteRuleInput{
		Pattern:  record.Alias,
		Scope:    scope,
		Route:    route,
		Priority: record.Priority,
	})
	if err != nil {
		return inferencegateway.RouteRule{}, false
	}
	return rule, true
}
