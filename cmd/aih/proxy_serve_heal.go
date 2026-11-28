package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxyendpoints"
	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

// 长驻代理入口的自愈边界。
//
// `aih proxy serve` 的 loopback 端口在租约创建时确定，因此「换出口」不是
// 换个上游那么轻：系统代理、TUN 路由和已发布的入口文件都指向这个端口。
// 所以自愈的单位是「整套入口」重建，而不是只补一条连接。
//
// 何时允许自愈：
//   - 只有 selector 是 auto/pool 时。用户点名某个节点等于选定出口，
//     和 install --proxy 一样不能静默换到别的出口 IP。
//   - 只有续期失败属于「出口没了」，而不是本机入口自身出错。

// serveEntryUnit 是一个可重建的完整入口：租约 + 可选 TUN/系统代理 + 发布文件。
// Close 必须幂等，且按与创建相反的顺序拆除，避免残留系统代理。
type serveEntryUnit struct {
	lease   *serveLease
	tunDone <-chan struct{}
	// closeTUN 与 restoreSystem 由各自的创建函数返回，可能为 nil。
	closeTUN      func()
	restoreSystem func()
	// unpublish 只删除本次写入的入口文件（核对 PID）。
	unpublish func()
	// unpublishEndpoint 删除本进程发布的 <port>.json geo 记录。
	unpublishEndpoint func()
}

func (unit *serveEntryUnit) Close() error {
	if unit == nil {
		return nil
	}
	// 先恢复系统代理：它指向即将关闭的端口，顺序反了会让宿主短暂指向死端口。
	if unit.restoreSystem != nil {
		unit.restoreSystem()
		unit.restoreSystem = nil
	}
	if unit.closeTUN != nil {
		unit.closeTUN()
		unit.closeTUN = nil
	}
	if unit.unpublish != nil {
		unit.unpublish()
		unit.unpublish = nil
	}
	if unit.unpublishEndpoint != nil {
		unit.unpublishEndpoint()
		unit.unpublishEndpoint = nil
	}
	if unit.lease != nil {
		err := unit.lease.Close()
		unit.lease = nil
		return err
	}
	return nil
}

// newServeEntryUnit 按当前选择器完整建立一次入口。
func newServeEntryUnit(ctx context.Context, runtime commandRuntime, options proxyServeOptions) (*serveEntryUnit, error) {
	lease, err := acquireServeLease(ctx, runtime, options.selector, !options.noSocks, options.httpPort, options.socksPort, options.anonymous, options.httpPortSet, options.socksPortSet, options.inPlace)
	if err != nil {
		return nil, err
	}
	unit := &serveEntryUnit{lease: lease}
	// 所有 serve 进程（含临时前台入口）都发布自己的地区元数据；它不含凭据，
	// 只让应用看台按端口显示国家/城市。
	if home, homeErr := resolveAIHomeDir(runtime); homeErr == nil {
		if cleanup, publishErr := proxyendpoints.Publish(home, lease.httpURL, lease.name, options.selector); publishErr != nil {
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 未能发布代理入口地区信息: %v\n", publishErr)
		} else {
			unit.unpublishEndpoint = cleanup
		}
	}
	fail := func(cause error) (*serveEntryUnit, error) {
		_ = unit.Close()
		return nil, cause
	}
	if options.tun {
		closeTUN, done, tunErr := startTUN(ctx, runtime, lease, options)
		if tunErr != nil {
			return fail(tunErr)
		}
		unit.closeTUN, unit.tunDone = closeTUN, done
	}
	if options.system {
		address, ingressErr := lease.startSystemIngress(ctx)
		if ingressErr != nil {
			return fail(ingressErr)
		}
		restore, applyErr := applySystemProxy(ctx, runtime, address, options.systemService, options.systemDryRun, options.systemForce)
		if applyErr != nil {
			return fail(applyErr)
		}
		unit.restoreSystem = restore
	}
	// 只有受监督的常驻实例发布入口：临时手工启动的 serve 若也写同一路径，
	// 会在退出时删掉常驻服务的入口。
	if options.exitWithParent {
		if home, homeErr := resolveAIHomeDir(runtime); homeErr == nil {
			cleanup, publishErr := publishServeEntry(home, lease)
			if publishErr != nil {
				_, _ = fmt.Fprintf(runtime.stderr, "[aih] 未能发布本机代理入口状态: %v\n", publishErr)
			} else {
				unit.unpublish = cleanup
			}
		}
	}
	return unit, nil
}

// serveSelfHeal 判断 selector 是否允许自愈，并给出不该自愈时的原因。
func serveSelfHeal(selector string) bool {
	if _, scoped, err := proxyregion.Parse(selector); err == nil && scoped {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(selector)) {
	case "", "auto", "pool":
		return true
	default:
		return false
	}
}

// serveRotation 用当前 selector 建立轮换器；不可自愈或没有凭据时返回 nil。
//
// 复用 updateproxy 的同一套状态机：候选顺序、跳过已试出口、释放租约都只有
// 一份实现，不在这里另写一套「换下一个」。
func serveRotation(ctx context.Context, runtime commandRuntime, selector string, notify func(string)) *updateproxy.EgressRotation {
	if !serveSelfHeal(selector) {
		return nil
	}
	client, err := managementProxyClient(runtime)
	if err != nil {
		return nil
	}
	_ = ctx
	if filter, scoped, parseErr := proxyregion.Parse(selector); parseErr == nil && scoped {
		return client.RotationWithFilter(filter, notify)
	}
	return client.Rotation(notify)
}

// isLeaseLossError 判断续期失败是否属于「这个出口已经不可用」。
//
// 管理面在租约过期时返回 404、出口断开时 Upgrade 失败；这两类换下一个出口
// 有意义。认证/权限失败换多少出口都一样，必须如实失败而不是反复重建入口。
func isLeaseLossError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	for _, marker := range []string{
		"proxy_lease_lost", "404", "410", "proxy_lease_expired", "lease unavailable",
		"upgrade", "连接失败", "不可用",
		"econnrefused", "connection refused", "timeout", "超时",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// retryRecovery retries a transient management-plane recovery. A Server
// restart makes the API unreachable for a few seconds; treating that as fatal
// turned every temporary app entry into a dead port.
func retryRecovery(ctx context.Context, attempts int, delay time.Duration, attempt func() error) error {
	var err error
	for index := 0; index < attempts; index++ {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err = attempt(); err == nil {
			return nil
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

// rotateServeEntry 在当前出口失效后换下一个候选并完整重建入口。
//
// 返回新 unit 与是否成功；失败时调用方应保留原失败语义退出，不做无限重试。
func rotateServeEntry(
	ctx context.Context,
	runtime commandRuntime,
	options proxyServeOptions,
	rotation *updateproxy.EgressRotation,
	cause string,
) (*serveEntryUnit, string, error) {
	if rotation == nil {
		return nil, "", errors.New("此 selector 不允许自动换出口")
	}
	next, err := rotation.Next(ctx, cause)
	if err != nil {
		return nil, "", err
	}
	if next.Exhausted {
		return nil, "", errors.New(next.Message)
	}
	// 用新出口的稳定 ID 重建整套入口；TUN/系统代理/发布文件都指向新端口。
	rotated := options
	rotated.selector = selectorForLease(next.Lease)
	unit, buildErr := newServeEntryUnit(ctx, runtime, rotated)
	if buildErr != nil {
		rotation.Fail(cause)
		return nil, next.Lease.Name, buildErr
	}
	return unit, next.Lease.Name, nil
}

// selectorForLease 从租约里取回可用于重建的选择器。
//
// managementproxy 的轮换器不对外暴露它用的是哪个候选 ID，而 serve 需要它来
// 重新建立同名出口。租约名即候选显示名，管理面接受唯一名称。
func selectorForLease(lease updateproxy.EgressLease) string {
	if id := strings.TrimSpace(lease.ID); id != "" {
		return id
	}
	if name := strings.TrimSpace(lease.Name); name != "" {
		return name
	}
	return "auto"
}
