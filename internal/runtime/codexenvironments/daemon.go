package codexenvironments

import (
	"context"
	"strings"
	"time"
)

const (
	// URLHostReconcileInterval 是常驻同步的间隔。
	//
	// 每轮只做一次本地 KV 读取和集合比较；只有新增连接才会真的连 SSH 探测。
	// 间隔短一点，用户在 WebUI 新增连接后很快就能在 Codex 里用上。
	URLHostReconcileInterval = 3 * time.Second
	// urlHostReconcileTimeout 是单轮探测的硬上限，避免 SSH 卡死把下一轮拖住。
	urlHostReconcileTimeout = 45 * time.Second
)

// StartURLHostDaemon 在后台维持 url 模式通道宿主。
//
// 这是 url 模式真正生效的接线点：CLI 同步只能写文件，不能持有常驻监听；
// 宿主必须由常驻进程（aih-server）按当前 ssh_connections 持续对齐。
// 连接新增/删除由下一轮 reconcile 收敛，宿主断线由 HostSupervisor 自己退避重建。
func StartURLHostDaemon(ctx context.Context, supervisor *HostSupervisor, aiHomeDir, homeDir string) {
	if supervisor == nil || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		for {
			reconcileCtx, cancel := context.WithTimeout(ctx, urlHostReconcileTimeout)
			ReconcileURLHosts(reconcileCtx, ProbeOptions{
				AIHomeDir:      aiHomeDir,
				HomeDir:        homeDir,
				HostSupervisor: supervisor,
			})
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-time.After(URLHostReconcileInterval):
			}
		}
	}()
}
