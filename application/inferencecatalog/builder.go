// Package inferencecatalog 把账号管理维护的本地模型索引编译为不可变推理路由快照。
//
// 该应用层不读取 SQLite、凭据或上游目录；Provider 差异由注入的 RouteFactory
// 表达，构建成功后由独立原子目录一次性发布。
package inferencecatalog

import (
	"context"
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidBuilder 表示模型读取端口或 Provider Factory 注册无效。
	ErrInvalidBuilder = errors.New("生产路由目录 Builder 配置无效")
	// ErrInvalidModelSnapshot 表示本地模型快照无效、重复或未按合同排序。
	ErrInvalidModelSnapshot = errors.New("生产路由模型快照无效")
	// ErrProviderRouteFactoryNotFound 表示本地模型所属 Provider 没有路由策略。
	ErrProviderRouteFactoryNotFound = errors.New("Provider 路由 Factory 不存在")
	// ErrInvalidProviderRoute 表示 Factory 返回了不属于当前模型的路由。
	ErrInvalidProviderRoute = errors.New("Provider 路由 Factory 返回无效路由")
)

// ProviderRouteFactory 把一个 Provider 的真实模型编译为其原生上游路由。
//
// Factory 可以按模型返回不同能力，避免 Builder 根据模型命名猜测协议或能力。
type ProviderRouteFactory interface {
	// ProviderID 返回该 Factory 唯一拥有的规范 Provider。
	ProviderID() inference.ProviderID
	// BuildRoute 为真实模型创建上游协议和已验证能力合同。
	BuildRoute(
		modelID runtimecore.ModelID,
	) (inferencegateway.Route, error)
}

// Builder 从本地物化模型读取端口创建完整不可变快照。
type Builder struct {
	models    accountapp.RoutableModelReader
	factories map[inference.ProviderID]ProviderRouteFactory
	// relayProviders 声明由独立透传通道执行、不进 Canonical 路由目录的 Provider。
	// 键是账号目录里的 Provider ID（字符串），不经过 Canonical 的封闭 Provider 集合。
	relayProviders map[string]struct{}
	// aliases 是 Node 推送的模型别名投影；为空表示 Go 不做别名改写（全部交还 Node）。
	aliases *modelalias.Store
}

// NewBuilder 注册互不重复的 Provider RouteFactory。
func NewBuilder(
	models accountapp.RoutableModelReader,
	factories ...ProviderRouteFactory,
) (*Builder, error) {
	if models == nil || len(factories) == 0 {
		return nil, ErrInvalidBuilder
	}
	registry := make(
		map[inference.ProviderID]ProviderRouteFactory,
		len(factories),
	)
	for _, factory := range factories {
		if factory == nil {
			return nil, ErrInvalidBuilder
		}
		providerID := factory.ProviderID()
		if !providerID.IsValid() || registry[providerID] != nil {
			return nil, ErrInvalidBuilder
		}
		registry[providerID] = factory
	}
	return &Builder{
		models:    models,
		factories: registry,
	}, nil
}

// Build 读取一次本地模型快照并生成精确、无歧义的 RouteCatalog。
func (builder *Builder) Build(ctx context.Context) (*Snapshot, error) {
	if builder == nil || builder.models == nil || ctx == nil {
		return nil, ErrInvalidBuilder
	}
	if err := builder.validateRelayProviders(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	models, err := builder.models.ListRoutableModels(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidModelSnapshot, err)
	}
	if err := validateModelSnapshot(models); err != nil {
		return nil, err
	}
	if len(models) == 0 {
		// 没有本地可路由模型时仍要记录别名投影的编译结果，管理接口才能如实回报
		// 「哪些别名 Go 接不了」，而不是静默丢失。
		return newSnapshot(nil, nil, 0, 0, builder.compileAliases(models, nil)), nil
	}
	rules := make([]inferencegateway.RouteRule, 0, len(models))
	identities := make(map[ruleIdentity]struct{}, len(models))
	routedModels := make([]accountapp.RoutableModel, 0, len(models))
	for _, model := range models {
		if builder.isRelayModel(model) {
			// 透传通道执行的模型进入展示目录与账号路由索引，但不编译 Canonical
			// 执行规则：通道选择由入口挂载决定，出现规则反而会制造第二处真相。
			continue
		}
		rule, buildErr := builder.buildRule(model)
		if buildErr != nil {
			return nil, buildErr
		}
		rules = append(rules, rule)
		identities[identityOf(rule)] = struct{}{}
		routedModels = append(routedModels, model)
	}
	compilation := builder.compileAliases(models, identities)
	rules = append(rules, compilation.Rules...)
	var routes *inferencegateway.RouteCatalog
	if len(rules) > 0 {
		routes, err = inferencegateway.NewRouteCatalog(rules...)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInvalidProviderRoute, err)
		}
	}
	display := uniqueModels(models)
	displayOnly := countDisplayOnlyModels(display, routedModels)
	return newSnapshot(routes, display, len(rules), displayOnly, compilation), nil
}

// WithRelayProviders 声明由独立透传通道承载、不进 Canonical 路由目录的 Provider。
//
// 家族透传（CodeBuddy / WorkBuddy 四支）由专用 HTTP 通道直连官方端点，不经过
// Canonical 执行计划：它们的模型必须出现在展示目录里（交还判定与 /v1/models
// 依赖它），但不存在也不应该存在 RouteRule。未声明且没有 Factory 的 Canonical
// Provider 仍然是 Build 的硬错误——那通常意味着漏注册 Factory，静默跳过会把
// 故障推到运行时。
func (builder *Builder) WithRelayProviders(providers ...string) *Builder {
	if builder == nil {
		return builder
	}
	registry := make(map[string]struct{}, len(providers))
	for _, providerID := range providers {
		registry[providerID] = struct{}{}
	}
	builder.relayProviders = registry
	return builder
}

// validateRelayProviders 拒绝空 Provider ID：静默忽略会让「声明的透传通道」
// 和「实际跳过的模型」悄悄不一致。
func (builder *Builder) validateRelayProviders() error {
	for providerID := range builder.relayProviders {
		if strings.TrimSpace(providerID) == "" {
			return ErrInvalidBuilder
		}
	}
	return nil
}

// isRelayModel 判断该模型是否由声明的透传通道执行。
func (builder *Builder) isRelayModel(model accountapp.RoutableModel) bool {
	if builder == nil || len(builder.relayProviders) == 0 {
		return false
	}
	_, relay := builder.relayProviders[model.ProviderID()]
	return relay
}

// countDisplayOnlyModels 统计展示目录里没有 Canonical 执行规则的模型数。
//
// 这些模型由透传通道执行；快照不变量据此放行「展示多于规则」，同时仍然拒绝
// 无法解释的缺口。
func countDisplayOnlyModels(
	display []accountapp.RoutableModel,
	routed []accountapp.RoutableModel,
) int {
	if len(display) == 0 {
		return 0
	}
	routedIDs := make(map[string]struct{}, len(routed))
	for _, model := range routed {
		routedIDs[model.ModelID().String()] = struct{}{}
	}
	displayOnly := 0
	for _, model := range display {
		if _, ok := routedIDs[model.ModelID().String()]; !ok {
			displayOnly++
		}
	}
	return displayOnly
}

// WithAliasStore 让 Builder 在编译目录时并入 Node 的模型别名投影；store 可为 nil，
// 表示 Go 不做别名改写（命中别名的请求继续由 Node 承接）。
func (builder *Builder) WithAliasStore(store *modelalias.Store) *Builder {
	if builder != nil {
		builder.aliases = store
	}
	return builder
}

// buildRule 让 Provider Factory 决定上游协议和能力，Builder 只维护精确匹配。
func (builder *Builder) buildRule(
	model accountapp.RoutableModel,
) (inferencegateway.RouteRule, error) {
	providerID := inference.ProviderID(model.ProviderID())
	factory := builder.factories[providerID]
	if factory == nil {
		return inferencegateway.RouteRule{}, ErrProviderRouteFactoryNotFound
	}
	route, err := factory.BuildRoute(model.ModelID())
	if err != nil {
		return inferencegateway.RouteRule{}, fmt.Errorf(
			"%w: %w",
			ErrInvalidProviderRoute,
			err,
		)
	}
	if !route.IsValid() ||
		route.ProviderID() != providerID ||
		route.EffectiveModel() != model.ModelID().String() {
		return inferencegateway.RouteRule{}, ErrInvalidProviderRoute
	}
	rule, err := inferencegateway.NewRouteRule(
		inferencegateway.RouteRuleInput{
			Pattern: model.ModelID().String(),
			Scope:   inferencegateway.RouteScopeAll,
			Route:   route,
		},
	)
	if err != nil {
		return inferencegateway.RouteRule{}, fmt.Errorf(
			"%w: %w",
			ErrInvalidProviderRoute,
			err,
		)
	}
	return rule, nil
}

// validateModelSnapshot 确保模型按 model/provider 排序且同一 Provider 不重复。
func validateModelSnapshot(models []accountapp.RoutableModel) error {
	for index, model := range models {
		if !model.IsValid() {
			return ErrInvalidModelSnapshot
		}
		if index == 0 {
			continue
		}
		previous := models[index-1]
		currentModelID := model.ModelID().String()
		previousModelID := previous.ModelID().String()
		if currentModelID < previousModelID ||
			(currentModelID == previousModelID &&
				model.ProviderID() <= previous.ProviderID()) {
			return ErrInvalidModelSnapshot
		}
	}
	return nil
}

// uniqueModels 对展示目录按模型去重；真实 route 仍保留每个 Provider 的候选。
// RouteCatalog 已显式保存 Provider、协议和声明顺序，因此同名跨 Provider 不是
// 猜测或歧义，而是 Coordinator 可顺序执行的候选池。
func uniqueModels(
	models []accountapp.RoutableModel,
) []accountapp.RoutableModel {
	filtered := make([]accountapp.RoutableModel, 0, len(models))
	for _, model := range models {
		if len(filtered) == 0 || filtered[len(filtered)-1].ModelID() != model.ModelID() {
			filtered = append(filtered, model)
		}
	}
	return filtered
}
