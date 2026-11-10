package webuisetdefaultapi

import (
	"context"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

// ProviderDefaultsAdapter 把 application/accounts.ProviderDefaults 接到
// DefaultRelations 端口，并挡住 typed-nil：直接把 nil *ProviderDefaults 赋给
// 接口会让 Handler 误以为依赖已就位，真实请求才 panic。
type ProviderDefaultsAdapter struct {
	Defaults *accountapp.ProviderDefaults
}

// NewProviderDefaultsAdapter 包装应用层默认账号用例；nil 会被保留为空适配器。
func NewProviderDefaultsAdapter(
	defaults *accountapp.ProviderDefaults,
) ProviderDefaultsAdapter {
	return ProviderDefaultsAdapter{Defaults: defaults}
}

// Available 报告底层用例是否可用。
func (adapter ProviderDefaultsAdapter) Available() bool {
	return adapter.Defaults != nil
}

// Set 直接把应用层校验过的事务写入透传出去。
func (adapter ProviderDefaultsAdapter) Set(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (accountcore.ProviderDefault, error) {
	if !adapter.Available() {
		return accountcore.ProviderDefault{}, accountapp.ErrInvalidProviderDefaultDependencies
	}
	return adapter.Defaults.Set(ctx, providerID, accountRef)
}

// Clear 幂等清除默认关系。
func (adapter ProviderDefaultsAdapter) Clear(
	ctx context.Context,
	providerID string,
) error {
	if !adapter.Available() {
		return accountapp.ErrInvalidProviderDefaultDependencies
	}
	return adapter.Defaults.Clear(ctx, providerID)
}

var _ DefaultRelations = ProviderDefaultsAdapter{}

// ServerDefaultsAdapter 把 internal/host/aihdefault.Store 接到 ServerDefaultState
// 端口：落点指针的读写规则仍归 aihdefault，Handler 只做编排。
type ServerDefaultsAdapter struct {
	Store aihdefault.Store
}

// NewServerDefaultsAdapter 包装宿主侧 AIH Server 档位存储。
func NewServerDefaultsAdapter(store aihdefault.Store) ServerDefaultsAdapter {
	return ServerDefaultsAdapter{Store: store}
}

// Available 报告存储是否绑定了 app-state.db。
func (adapter ServerDefaultsAdapter) Available() bool {
	return adapter.Store.DatabasePath != ""
}

// ClearProviderProfile 删除残留档位；原本没有该键时返回 false。
func (adapter ServerDefaultsAdapter) ClearProviderProfile(
	ctx context.Context,
	provider string,
) (bool, error) {
	return adapter.Store.ClearProviderProfile(ctx, provider)
}

// LandOnServerDefault 走 aihdefault 的唯一落点实现（先宿主、后指针）。
func (adapter ServerDefaultsAdapter) LandOnServerDefault(
	ctx context.Context,
	provider string,
	sync aihdefault.GatewaySync,
) aihdefault.LandResult {
	return aihdefault.LandOnServerDefault(ctx, adapter.Store, provider, sync)
}

var _ ServerDefaultState = ServerDefaultsAdapter{}

// HostSelectorFunc 让 wiring 直接注入 Node 侧的 syncGlobalConfigToHost。
// nil 函数返回 host_sync_unavailable，路由据此保持 501 而不是伪造成功。
type HostSelectorFunc func(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) error

// SelectAccount 实现 HostAccountSelector。
func (fn HostSelectorFunc) SelectAccount(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) error {
	if fn == nil {
		return hostProjectionUnavailable()
	}
	return fn(ctx, providerID, accountRef)
}

// HostGatewayFunc 让 wiring 注入网关档落点回调。
type HostGatewayFunc func(ctx context.Context, providerID string) error

// LandGateway 实现 HostGatewayLander。
func (fn HostGatewayFunc) LandGateway(ctx context.Context, providerID string) error {
	if fn == nil {
		return hostProjectionUnavailable()
	}
	return fn(ctx, providerID)
}

// HostGrantFunc 让 wiring 注入直连授权回收回调。
type HostGrantFunc func(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (bool, error)

// RevokeGrant 实现 HostGrantRevoker。
func (fn HostGrantFunc) RevokeGrant(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (bool, error) {
	if fn == nil {
		return false, hostProjectionUnavailable()
	}
	return fn(ctx, providerID, accountRef)
}

// HostProjection 汇总宿主投影回调；未注入的能力返回 nil，由 Handler 显式 501。
type HostProjection struct {
	SelectAccount HostSelectorFunc
	LandGateway   HostGatewayFunc
	RevokeGrant   HostGrantFunc
}

// Selector 返回可用的账号钉选端口；未注入时为 nil。
func (projection HostProjection) Selector() HostAccountSelector {
	if projection.SelectAccount == nil {
		return nil
	}
	return projection.SelectAccount
}

// Gateway 返回可用的网关落点端口；未注入时为 nil。
func (projection HostProjection) Gateway() HostGatewayLander {
	if projection.LandGateway == nil {
		return nil
	}
	return projection.LandGateway
}

// GrantRevoker 返回可用的授权回收端口；未注入时为 nil。
func (projection HostProjection) GrantRevoker() HostGrantRevoker {
	if projection.RevokeGrant == nil {
		return nil
	}
	return projection.RevokeGrant
}

// HostFileTarget 描述一个 Provider 的受管宿主配置文件。BuildAccount 负责把
// 指定账号写进文件，BuildGateway 负责写无钉选网关档；缺失的能力返回 501。
type HostFileTarget struct {
	Target       aihdefault.Target
	BuildAccount func(accountRef accountcore.AccountRef) aihdefault.BuildContent
	BuildGateway aihdefault.BuildContent
}

// HostFileProjection 是「内容构造已迁到 Go」的 Provider 的 HostSelector +
// HostGate 实现；构造仍留在 Node 的 Provider 不要放进 Targets。
type HostFileProjection struct {
	Targets map[string]HostFileTarget
}

// SelectAccount 把宿主文件写成指定账号档并记录接管基线。
func (projection HostFileProjection) SelectAccount(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) error {
	target, found := projection.resolve(providerID, func(target HostFileTarget) bool {
		return target.BuildAccount != nil
	})
	if !found {
		return hostProjectionUnavailable()
	}
	build := target.BuildAccount(accountRef)
	if build == nil {
		return &aihdefault.Error{Code: aihdefault.CodeInvalidProfile}
	}
	_, err := aihdefault.ActivateProfile(target.Target, build)
	return err
}

// LandGateway 把宿主文件写成无钉选网关档并记录接管基线。
func (projection HostFileProjection) LandGateway(
	ctx context.Context,
	providerID string,
) error {
	target, found := projection.resolve(providerID, func(target HostFileTarget) bool {
		return target.BuildGateway != nil
	})
	if !found {
		return hostProjectionUnavailable()
	}
	_, err := aihdefault.ActivateProfile(target.Target, target.BuildGateway)
	return err
}

func (projection HostFileProjection) resolve(
	providerID string,
	usable func(HostFileTarget) bool,
) (HostFileTarget, bool) {
	normalized := aihdefault.NormalizeProvider(providerID)
	target, found := projection.Targets[normalized]
	if !found || !usable(target) {
		return HostFileTarget{}, false
	}
	return target, true
}

var (
	_ HostAccountSelector = HostFileProjection{}
	_ HostGatewayLander   = HostFileProjection{}
)

// BuildDependencies 是 wiring 的单点组装：应用层默认关系、宿主侧档位存储
// 与宿主回调一次接好；缺失的宿主能力保持 nil，路由返回 501。
func BuildDependencies(
	authorizer Authorizer,
	aiHomeDir string,
	catalog *providers.Catalog,
	defaults *accountapp.ProviderDefaults,
	projection HostProjection,
) Dependencies {
	return Dependencies{
		Authorizer:   authorizer,
		AIHomeDir:    aiHomeDir,
		Catalog:      catalog,
		Defaults:     NewProviderDefaultsAdapter(defaults),
		HostSelector: projection.Selector(),
		HostGate:     projection.Gateway(),
		HostGrant:    projection.GrantRevoker(),
	}
}

func hostProjectionUnavailable() error {
	return &aihdefault.Error{Code: aihdefault.CodeHostSyncUnavailable}
}
