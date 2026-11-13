package network

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const networkLayerTTL = 10 * time.Second

// TunReport 描述系统 TUN / 虚拟网卡探测状态。
type TunReport struct {
	State             string   `json:"state"`
	Owner             *string  `json:"owner"`
	InterfaceDetected bool     `json:"interfaceDetected"`
	RouteDetected     bool     `json:"routeDetected"`
	Evidence          []string `json:"evidence"`
}

// NetworkLayerReport 描述当前操作系统出口网络层综合判定。
type NetworkLayerReport struct {
	Platform            string            `json:"platform"`
	SystemProxy         SystemProxyReport `json:"systemProxy"`
	Tun                 TunReport         `json:"tun"`
	EffectiveRoute      string            `json:"effectiveRoute"`
	EffectiveRouteKnown bool              `json:"effectiveRouteKnown"`
	Stale               bool              `json:"stale,omitempty"`
}

var (
	reMacUtunIf      = regexp.MustCompile(`(?m)(?:^|\n)utun\d+:`)
	reMacUtunRoute   = regexp.MustCompile(`(?i)utun\d+`)
	reLinuxRouteLine = regexp.MustCompile(`(?m)(^|\n)\d+:`)
	reWinTunIf       = regexp.MustCompile(`(?i)wintun|wireguard|tap|tun`)
	reWinTunRoute    = regexp.MustCompile(`(?i)wintun|wireguard|0\.0\.0\.0\s+0\.0\.0\.0`)
	reClashVergeProc = regexp.MustCompile(`clash[- ]?verge|verge[- ]mihomo`)
	reMihomoProc     = regexp.MustCompile(`mihomo|clash-meta`)
	reSingBoxProc    = regexp.MustCompile(`sing-box|singbox`)
)

// ClearNetworkLayerCache 清空网络层探测缓存。
func (manager *Manager) ClearNetworkLayerCache() {
	manager.layerMu.Lock()
	defer manager.layerMu.Unlock()
	manager.layerCached = nil
	manager.layerCachedAt = time.Time{}
}

// DetectNetworkLayer 判定当前流量走 TUN、系统代理或未知直连（带 10s SWR 缓存）。
func (manager *Manager) DetectNetworkLayer(ctx context.Context, forceRefresh bool) NetworkLayerReport {
	if forceRefresh {
		return manager.refreshNetworkLayer(ctx)
	}
	manager.layerMu.Lock()
	if manager.layerCached != nil {
		copyVal := *manager.layerCached
		stale := manager.now().Sub(manager.layerCachedAt) >= networkLayerTTL
		shouldRefresh := stale && !manager.layerLoading
		manager.layerMu.Unlock()
		if shouldRefresh {
			go func() {
				bgCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				_ = manager.refreshNetworkLayer(bgCtx)
			}()
		}
		if stale {
			copyVal.Stale = true
		}
		return copyVal
	}
	manager.layerMu.Unlock()
	return manager.refreshNetworkLayer(ctx)
}

func (manager *Manager) refreshNetworkLayer(ctx context.Context) NetworkLayerReport {
	manager.layerMu.Lock()
	if manager.layerLoading {
		for manager.layerLoading {
			manager.layerCond.Wait()
		}
		if manager.layerCached != nil {
			res := *manager.layerCached
			manager.layerMu.Unlock()
			return res
		}
	}
	manager.layerLoading = true
	manager.layerMu.Unlock()

	value := manager.detectNetworkLayerUncached(ctx)

	manager.layerMu.Lock()
	manager.layerCached = &value
	manager.layerCachedAt = manager.now()
	manager.layerLoading = false
	manager.layerCond.Broadcast()
	manager.layerMu.Unlock()
	return value
}

func (manager *Manager) detectNetworkLayerUncached(ctx context.Context) NetworkLayerReport {
	var (
		sysProxy SystemProxyReport
		tun      TunReport
	)
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		sysProxy = manager.DetectSystemProxy(ctx)
	}()
	go func() {
		defer group.Done()
		tun = manager.DetectTun(ctx)
	}()
	group.Wait()

	effectiveRoute := "direct-unknown"
	switch {
	case tun.State == "active":
		effectiveRoute = "tun"
	case sysProxy.Enabled:
		effectiveRoute = "system-proxy"
	case tun.State == "unknown":
		effectiveRoute = "unknown"
	}
	return NetworkLayerReport{
		Platform:            manager.goos,
		SystemProxy:         sysProxy,
		Tun:                 tun,
		EffectiveRoute:      effectiveRoute,
		EffectiveRouteKnown: effectiveRoute != "direct-unknown" && effectiveRoute != "unknown",
	}
}

// DetectTun 探测操作系统上的 TUN 设备、默认路由和已知代理内核进程。
func (manager *Manager) DetectTun(ctx context.Context) TunReport {
	var ifOut, routeOut, procOut string
	var ifMatch, routeMatch bool

	switch manager.goos {
	case "darwin":
		ifRes, routeRes, procRes := manager.runThree(ctx,
			cmdSpec{bin: "ifconfig"},
			cmdSpec{bin: "netstat", args: []string{"-rn"}},
			cmdSpec{bin: "ps", args: []string{"-axo", "pid=,command="}},
		)
		ifOut, routeOut, procOut = ifRes.Stdout, routeRes.Stdout, procRes.Stdout
		ifMatch = reMacUtunIf.MatchString(ifOut)
		routeMatch = reMacUtunRoute.MatchString(routeOut)
	case "linux":
		ifRes, routeRes, procRes := manager.runThree(ctx,
			cmdSpec{bin: "ip", args: []string{"-o", "link", "show", "type", "tun"}},
			cmdSpec{bin: "ip", args: []string{"rule", "show"}},
			cmdSpec{bin: "ps", args: []string{"-eo", "pid=,command="}},
		)
		ifOut, routeOut, procOut = ifRes.Stdout, routeRes.Stdout, procRes.Stdout
		ifMatch = strings.TrimSpace(ifOut) != ""
		routeMatch = reLinuxRouteLine.MatchString(routeOut)
	case "windows":
		psArgs := []string{"-NoProfile", "-NonInteractive", "-Command"}
		ifRes, routeRes, procRes := manager.runThree(ctx,
			cmdSpec{bin: "powershell.exe", args: append(append([]string{}, psArgs...), "Get-NetAdapter | Select-Object Name,Status,InterfaceDescription | ConvertTo-Json -Compress")},
			cmdSpec{bin: "route.exe", args: []string{"print"}},
			cmdSpec{bin: "powershell.exe", args: append(append([]string{}, psArgs...), "Get-Process | Select-Object Name,Id | ConvertTo-Json -Compress")},
		)
		ifOut, routeOut, procOut = ifRes.Stdout, routeRes.Stdout, procRes.Stdout
		ifMatch = reWinTunIf.MatchString(ifOut)
		routeMatch = reWinTunRoute.MatchString(ifOut + "\n" + routeOut)
	default:
		return TunReport{State: "inactive", Evidence: []string{}}
	}

	procActive, procOwner, procEvidence := parseTunProcesses(procOut)
	active := ifMatch && (routeMatch || procActive)
	state := "inactive"
	var ownerPtr *string
	if active {
		state = "active"
		ownerPtr = procOwner
	} else if ifMatch || routeMatch {
		state = "unknown"
	}

	evidence := make([]string, 0, 4)
	seen := map[string]struct{}{}
	addEvidence := func(item string) {
		if item == "" {
			return
		}
		if _, ok := seen[item]; !ok {
			seen[item] = struct{}{}
			evidence = append(evidence, item)
		}
	}
	if ifMatch {
		addEvidence("interface")
	}
	if routeMatch {
		addEvidence("route")
	}
	for _, item := range procEvidence {
		addEvidence(item)
	}

	return TunReport{
		State:             state,
		Owner:             ownerPtr,
		InterfaceDetected: ifMatch,
		RouteDetected:     routeMatch,
		Evidence:          evidence,
	}
}

type cmdSpec struct {
	bin  string
	args []string
}

func (manager *Manager) runThree(ctx context.Context, a, b, c cmdSpec) (environment.RunResult, environment.RunResult, environment.RunResult) {
	var ra, rb, rc environment.RunResult
	var group sync.WaitGroup
	group.Add(3)
	go func() {
		defer group.Done()
		ra = manager.exec.Run(ctx, a.bin, a.args, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		rb = manager.exec.Run(ctx, b.bin, b.args, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	go func() {
		defer group.Done()
		rc = manager.exec.Run(ctx, c.bin, c.args, environment.ExecOptions{Timeout: proxyCmdTimeout})
	}()
	group.Wait()
	return ra, rb, rc
}

func parseTunProcesses(text string) (bool, *string, []string) {
	lower := strings.ToLower(strings.TrimSpace(text))
	if lower == "" {
		return false, nil, nil
	}
	if reClashVergeProc.MatchString(lower) {
		owner := "clash-verge"
		return true, &owner, []string{"process:clash-verge"}
	}
	if reMihomoProc.MatchString(lower) {
		owner := "mihomo"
		return true, &owner, []string{"process:mihomo"}
	}
	if reSingBoxProc.MatchString(lower) {
		owner := "sing-box"
		return true, &owner, []string{"process:sing-box"}
	}
	owner := "external"
	return true, &owner, []string{"process:network-core"}
}
