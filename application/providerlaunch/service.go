package providerlaunch

import (
	"context"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

var (
	// ErrInvalidServiceDependencies 表示双模式启动服务缺少任一规划边界。
	ErrInvalidServiceDependencies = errors.New("Provider 启动服务依赖无效")
	// ErrInvalidServiceRequest 表示上下文或启动意图无效。
	ErrInvalidServiceRequest = errors.New("Provider 启动服务请求无效")
	// ErrNativePlannerUnavailable 表示当前 CLI 进程没有本地账号库，不能走 Native Direct。
	ErrNativePlannerUnavailable = errors.New("Native Direct 需要本地 AIH_HOME")
)

// NativePlanBuilder 是 Native Direct 分支唯一允许读取上游凭据的端口。
type NativePlanBuilder interface {
	Build(
		ctx context.Context,
		request accountapp.LaunchSelectionRequest,
	) (LaunchSpec, error)
}

// GatewayPlanBuilder 是 Gateway Relay 分支只读取 Server 配置和公开账号的端口。
type GatewayPlanBuilder interface {
	Build(
		ctx context.Context,
		intent LaunchIntent,
		endpoint GatewayEndpoint,
	) (GatewayLaunchSpec, error)
}

// ServiceDependencies 声明两种互斥启动路径。
type ServiceDependencies struct {
	Native  NativePlanBuilder
	Gateway GatewayPlanBuilder
}

// Service 按已经解析的 LaunchMode 分派且永不回退到另一认证路径。
type Service struct {
	native  NativePlanBuilder
	gateway GatewayPlanBuilder
}

// NewService 创建 Provider CLI 双模式应用服务。
func NewService(dependencies ServiceDependencies) (*Service, error) {
	// Gateway 账号池可以完全脱离本地库；Native 规划器按请求模式懒性要求。
	if dependencies.Gateway == nil {
		return nil, ErrInvalidServiceDependencies
	}
	return &Service{native: dependencies.Native, gateway: dependencies.Gateway}, nil
}

// LaunchPlan 是互斥保存 Native 或 Gateway 描述的不可变联合值。
type LaunchPlan struct {
	mode    LaunchMode
	native  LaunchSpec
	gateway GatewayLaunchSpec
}

// Plan 根据命令意图只调用一个规划器；任何分支错误都不会静默切换模式。
func (service *Service) Plan(
	ctx context.Context,
	intent LaunchIntent,
	endpoint GatewayEndpoint,
) (LaunchPlan, error) {
	if service == nil || service.gateway == nil || ctx == nil || !intent.IsValid() {
		return LaunchPlan{}, ErrInvalidServiceRequest
	}
	if err := ctx.Err(); err != nil {
		return LaunchPlan{}, err
	}
	switch intent.Mode() {
	case LaunchModeNativeDirect:
		if service.native == nil {
			return LaunchPlan{}, ErrNativePlannerUnavailable
		}
		request, err := intent.NativeSelectionRequest()
		if err != nil {
			return LaunchPlan{}, err
		}
		spec, err := service.native.Build(ctx, request)
		if err != nil {
			return LaunchPlan{}, err
		}
		plan := LaunchPlan{mode: LaunchModeNativeDirect, native: spec}
		if !plan.IsValid() {
			return LaunchPlan{}, ErrInvalidServiceRequest
		}
		return plan, nil
	case LaunchModeGatewayRelay:
		spec, err := service.gateway.Build(ctx, intent, endpoint)
		if err != nil {
			return LaunchPlan{}, err
		}
		plan := LaunchPlan{mode: LaunchModeGatewayRelay, gateway: spec}
		if !plan.IsValid() {
			return LaunchPlan{}, ErrInvalidServiceRequest
		}
		return plan, nil
	default:
		return LaunchPlan{}, ErrInvalidServiceRequest
	}
}

// Mode 返回本计划唯一执行模式。
func (plan LaunchPlan) Mode() LaunchMode {
	return plan.mode
}

// Native 返回 Native Direct 描述；Gateway 计划返回 false。
func (plan LaunchPlan) Native() (LaunchSpec, bool) {
	return plan.native, plan.mode == LaunchModeNativeDirect && plan.native.IsValid()
}

// Gateway 返回 Gateway Relay 描述；Native 计划返回 false。
func (plan LaunchPlan) Gateway() (GatewayLaunchSpec, bool) {
	return plan.gateway, plan.mode == LaunchModeGatewayRelay && plan.gateway.IsValid()
}

// IsValid 确保联合值只包含当前模式对应的有效描述。
func (plan LaunchPlan) IsValid() bool {
	switch plan.mode {
	case LaunchModeNativeDirect:
		return plan.native.IsValid() && !plan.gateway.IsValid()
	case LaunchModeGatewayRelay:
		return plan.gateway.IsValid() && !plan.native.IsValid()
	default:
		return false
	}
}

// String 返回不展开 Native 凭据环境或 Gateway Client Key 的安全摘要。
func (plan LaunchPlan) String() string {
	return fmt.Sprintf(
		"providerlaunch.LaunchPlan{mode=%s,native=%t,gateway=%t}",
		plan.mode,
		plan.native.IsValid(),
		plan.gateway.IsValid(),
	)
}

// GoString 确保 %#v 不会反射联合值内部的敏感环境。
func (plan LaunchPlan) GoString() string {
	return plan.String()
}

// Format 覆盖所有 fmt verb，避免格式化绕过脱敏摘要。
func (plan LaunchPlan) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(plan.String()))
}
