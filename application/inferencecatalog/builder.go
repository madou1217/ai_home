// Package inferencecatalog 把账号管理维护的本地模型索引编译为不可变推理路由快照。
//
// 该应用层不读取 SQLite、凭据或上游目录；Provider 差异由注入的 RouteFactory
// 表达，构建成功后由独立原子目录一次性发布。
package inferencecatalog

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidBuilder 表示模型读取端口或 Provider Factory 注册无效。
	ErrInvalidBuilder = errors.New("生产路由目录 Builder 配置无效")
	// ErrInvalidModelSnapshot 表示本地模型快照无效、重复或未按合同排序。
	ErrInvalidModelSnapshot = errors.New("生产路由模型快照无效")
	// ErrAmbiguousModelRoute 表示同一外部模型名指向多个 Provider 且没有显式策略。
	ErrAmbiguousModelRoute = errors.New("生产路由模型存在跨 Provider 歧义")
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
		return newSnapshot(nil, nil, 0), nil
	}
	rules := make([]inferencegateway.RouteRule, 0, len(models))
	for _, model := range models {
		rule, buildErr := builder.buildRule(model)
		if buildErr != nil {
			return nil, buildErr
		}
		rules = append(rules, rule)
	}
	routes, err := inferencegateway.NewRouteCatalog(rules...)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidProviderRoute, err)
	}
	return newSnapshot(routes, models, len(rules)), nil
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

// validateModelSnapshot 确保模型按 model/provider 排序且不会隐式跨 Provider fallback。
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
		if currentModelID == previousModelID {
			return ErrAmbiguousModelRoute
		}
	}
	return nil
}
