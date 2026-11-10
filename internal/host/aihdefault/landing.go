package aihdefault

import "context"

// GatewaySync 把宿主配置切到无钉选网关档。真正的宿主同步仍未迁到 Go：
// 调用方注入 Node 的 syncGlobalConfigToHost(provider, ”, { gateway: true })。
type GatewaySync func(ctx context.Context, provider string) error

// GatewayRestore 把宿主配置还原到接管前（Node: { restoreGateway: true }）。
type GatewayRestore func(ctx context.Context, provider string) error

// LandResult 是「默认账号未指定 ⇒ 落回 AIH Server」的结果。
type LandResult struct {
	OK            bool
	Landed        bool
	AlreadyLanded bool
	Provider      string
	Profile       string
	Reason        string
}

// RevokeResult 是取消 AIH Server 默认档位的结果。
type RevokeResult struct {
	OK           bool
	Revoked      bool
	HostRestored bool
	Provider     string
	Reason       string
}

// LandOnServerDefault 是 landing 的唯一 Go 实现：先让宿主同步成功，再记档位。
// 顺序不能反——先记档位会在同步失败时留下「档位说 AIH Server、宿主指向别处」。
func LandOnServerDefault(
	ctx context.Context,
	store Store,
	provider string,
	sync GatewaySync,
) LandResult {
	normalized, supported := store.ResolveProvider(provider)
	if !supported {
		return LandResult{OK: true, Provider: normalized, Reason: CodeProfileUnsupported}
	}
	if err := store.requireDatabase(); err != nil {
		return LandResult{OK: false, Provider: normalized, Reason: CodeScopeUnavailable}
	}
	if sync == nil {
		return LandResult{OK: false, Provider: normalized, Reason: CodeHostSyncUnavailable}
	}
	// 读取只用于幂等标记；读失败不阻断落点（Node 同样吞掉读错误）。
	alreadyLanded := false
	if profile, err := store.ReadProviderProfile(ctx, normalized); err == nil {
		alreadyLanded = profile == ServerProfileID
	}
	if err := sync(ctx, normalized); err != nil {
		reason := CodeOf(err)
		if reason == "" {
			reason = CodeGatewaySyncFailed
		}
		return LandResult{OK: false, Provider: normalized, Reason: reason}
	}
	if err := store.WriteProviderProfile(ctx, normalized, ServerProfileID); err != nil {
		return LandResult{OK: false, Provider: normalized, Reason: CodeOf(err)}
	}
	return LandResult{
		OK:            true,
		Landed:        true,
		AlreadyLanded: alreadyLanded,
		Provider:      normalized,
		Profile:       ServerProfileID,
	}
}

// RevokeServerDefault 取消档位：先还原宿主（有还原端口时），再删指针。
// 不做能力判断——档位可能来自旧目录声明，清理应当幂等且总能完成。
func RevokeServerDefault(
	ctx context.Context,
	store Store,
	provider string,
	restore GatewayRestore,
) RevokeResult {
	normalized := NormalizeProvider(provider)
	if err := store.requireDatabase(); err != nil {
		return RevokeResult{OK: false, Provider: normalized, Reason: CodeScopeUnavailable}
	}
	hostRestored := false
	if restore != nil {
		if err := restore(ctx, normalized); err != nil {
			reason := CodeOf(err)
			if reason == "" {
				reason = CodeGatewayRestoreFailed
			}
			return RevokeResult{OK: false, Provider: normalized, Reason: reason}
		}
		hostRestored = true
	}
	revoked, err := store.ClearProviderProfile(ctx, normalized)
	if err != nil {
		return RevokeResult{OK: false, HostRestored: hostRestored, Provider: normalized, Reason: CodeOf(err)}
	}
	return RevokeResult{
		OK:           true,
		Revoked:      revoked,
		HostRestored: hostRestored,
		Provider:     normalized,
	}
}
