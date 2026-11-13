package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type mockDesktopBridge struct {
	mu          sync.Mutex
	runningPIDs []int
	nextPID     int
	inspectErr  error
	closeErr    error
	launchErr   error
	closeCalls  int
	launchCalls int
	lastEgress  *EgressResolveResult
}

func (b *mockDesktopBridge) InspectRunning(_ context.Context, _ string, _ string) (DesktopInspectResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inspectErr != nil {
		return DesktopInspectResult{}, b.inspectErr
	}
	if len(b.runningPIDs) > 0 {
		return DesktopInspectResult{
			OK:     true,
			Status: "already_running",
			PIDs:   append([]int(nil), b.runningPIDs...),
		}, nil
	}
	return DesktopInspectResult{OK: true, Status: "not_running"}, nil
}

func (b *mockDesktopBridge) CloseApp(_ context.Context, _ string, _ string) (DesktopInspectResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closeCalls++
	if b.closeErr != nil {
		return DesktopInspectResult{OK: false, Error: "zcode_desktop_close_failed", Reason: b.closeErr.Error()}, nil
	}
	b.runningPIDs = nil
	return DesktopInspectResult{OK: true, Status: "closed"}, nil
}

func (b *mockDesktopBridge) LaunchApp(_ context.Context, _ string, _ string, egress *EgressResolveResult) (DesktopRestartResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.launchCalls++
	if egress != nil {
		cp := *egress
		b.lastEgress = &cp
	} else {
		b.lastEgress = nil
	}
	if b.launchErr != nil {
		return DesktopRestartResult{}, b.launchErr
	}
	b.nextPID++
	pid := 88000 + b.nextPID
	b.runningPIDs = []int{pid}
	return DesktopRestartResult{OK: true, Status: "launched", PID: pid}, nil
}

func TestProbeProxyAndPoolRotation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	// HTTP 204 代理测试。
	var statusCode atomic.Int32
	statusCode.Store(http.StatusNoContent)
	proxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(statusCode.Load()))
	}))
	defer proxySrv.Close()

	resOK := ProbeProxy(ctx, proxySrv.URL, "http://probe.invalid/generate_204", time.Second)
	if !resOK.OK {
		t.Fatalf("期望 204 探测成功，实际: %+v", resOK)
	}

	statusCode.Store(http.StatusBadGateway)
	res502 := ProbeProxy(ctx, proxySrv.URL, "http://probe.invalid/generate_204", time.Second)
	if res502.OK || res502.Error != "proxy_probe_failed" || res502.Reason != "http_502" {
		t.Fatalf("502 状态应报错 proxy_probe_failed/http_502，实际: %+v", res502)
	}

	resBadURL := ProbeProxy(ctx, "://not-a-url", "http://probe.invalid/generate_204", time.Second)
	if resBadURL.OK || resBadURL.Error != "proxy_probe_failed" || resBadURL.Reason != "invalid_proxy_url" {
		t.Fatalf("非法 proxyUrl 应报错 proxy_probe_failed/invalid_proxy_url，实际: %+v", resBadURL)
	}

	// ProbePoolEgressWithRotation：第 0 跳失败 -> 轮换到 node-1 -> 第 1 跳成功。
	var attempts atomic.Int32
	rotOK := ProbePoolEgressWithRotation(ctx, PoolProbeWithRotationInput{
		ProxyURL: "http://127.0.0.1:17893",
		Probe: func(_ context.Context, _ string) ProxyProbeResult {
			if attempts.Add(1) == 1 {
				return ProxyProbeResult{OK: false, Error: "proxy_unreachable", Reason: "first_fail"}
			}
			return ProxyProbeResult{OK: true}
		},
		CurrentNode: func(_ context.Context) string { return "node-0" },
		Rotate:      func(_ context.Context, from string) string { return "node-1" },
	})
	if !rotOK.OK || rotOK.Hops != 1 || rotOK.RotatedTo != "node-1" {
		t.Fatalf("期望第 1 次轮换后成功: %+v", rotOK)
	}

	// 达到 DefaultMaxProbeHops(4) 耗尽后失败关闭。
	rotFail := ProbePoolEgressWithRotation(ctx, PoolProbeWithRotationInput{
		ProxyURL: "http://127.0.0.1:17893",
		Probe: func(_ context.Context, _ string) ProxyProbeResult {
			return ProxyProbeResult{OK: false, Error: "proxy_unreachable", Reason: "still_bad"}
		},
		CurrentNode: func(_ context.Context) string { return "node-0" },
		Rotate:      func(_ context.Context, from string) string { return "node-1" },
	})
	if rotFail.OK || rotFail.Hops != DefaultMaxProbeHops || rotFail.Reason != "still_bad" {
		t.Fatalf("耗尽跳数应返回失败: %+v", rotFail)
	}
}

func TestResolveAccountEgressModesAndSchemeNarrowing(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()
	accRef := "acct_zcode_resolve_0001"
	nowMS := time.Now().UnixMilli()
	seedTestAccountRef(t, ctx, dir, accRef, "zcode", nowMS)

	var sysProxy atomic.Value
	sysProxy.Store(agyegress.SystemProxyStatus{Enabled: true, HTTPProxy: "http://127.0.0.1:8888"})
	var tunActive atomic.Bool
	tunActive.Store(true)

	mgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		Platform:             "darwin",
		DisableAutoDirectGeo: true,
		DisableProbeLoop:     true,
		SystemProxyDetector: func(_ context.Context) (agyegress.SystemProxyStatus, error) {
			return sysProxy.Load().(agyegress.SystemProxyStatus), nil
		},
		TUNDetector: func(_ context.Context) (agyegress.TUNStatus, error) {
			if tunActive.Load() {
				return agyegress.TUNStatus{State: "active", Owner: "Clash Verge"}, nil
			}
			return agyegress.TUNStatus{State: "inactive"}, nil
		},
		ProxyProbeFunc: func(_ context.Context, proxyURL string) ProxyProbeResult {
			if strings.Contains(proxyURL, "dead") {
				return ProxyProbeResult{OK: false, Error: "proxy_unreachable", Reason: "http_502"}
			}
			return ProxyProbeResult{OK: true}
		},
	})
	defer func() { _ = mgr.Close() }()

	// 1. 未绑定时返回 OK=true, Bound=false。
	resUnbound, err := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if err != nil || !resUnbound.OK || resUnbound.Bound {
		t.Fatalf("未绑定应返回 Bound=false: res=%+v err=%v", resUnbound, err)
	}

	// 2. 已退役绑定必须 fail-closed 拒绝。
	resRetired, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: "legacy_node", Retired: true},
	})
	if resRetired.OK || resRetired.Error != agyegress.ErrorModeRetired {
		t.Fatalf("已退役模式必须拦截: %+v", resRetired)
	}

	// 3. 非 macOS 平台拒绝 pool/system/tun。
	resLinuxPool, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		Platform:        "linux",
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModePool},
	})
	if resLinuxPool.OK || resLinuxPool.Error != agyegress.ErrorNotSupported {
		t.Fatalf("Linux 上 pool 模式应拒绝: %+v", resLinuxPool)
	}

	// 4. direct 直连免探测。
	resDirect, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeDirect},
	})
	if !resDirect.OK || !resDirect.Direct || resDirect.Source != agyegress.ModeDirect {
		t.Fatalf("direct 应放行: %+v", resDirect)
	}

	// 5. url 模式：zcode 必须拦截 socks5，仅放行 http/https。
	resSocks, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeURL, ProxyURL: "socks5://127.0.0.1:1080"},
	})
	if resSocks.OK || resSocks.Error != "zcode_native_proxy_scheme_unsupported" {
		t.Fatalf("zcode socks5 url 应报错 zcode_native_proxy_scheme_unsupported: %+v", resSocks)
	}
	resURLOK, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeURL, ProxyURL: "http://127.0.0.1:7890"},
	})
	if !resURLOK.OK || resURLOK.ProxyServer != "http://127.0.0.1:7890" {
		t.Fatalf("有效 HTTP url 应成功: %+v", resURLOK)
	}

	// 6. system 模式：系统代理为 socks5 时对 zcode 报错 ErrorSystemProxySchemeUnavailable；http 则通过。
	sysProxy.Store(agyegress.SystemProxyStatus{Enabled: true, SOCKSProxy: "socks5://127.0.0.1:7891"})
	resSysSocks, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeSystem},
	})
	if resSysSocks.OK || resSysSocks.Error != agyegress.ErrorSystemProxySchemeUnavailable {
		t.Fatalf("zcode 遇到 socks5 系统代理应报错 system_proxy_scheme_unavailable: %+v", resSysSocks)
	}
	sysProxy.Store(agyegress.SystemProxyStatus{Enabled: true, HTTPProxy: "http://127.0.0.1:7890"})
	resSysOK, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeSystem},
	})
	if !resSysOK.OK || resSysOK.Source != agyegress.ModeSystem || resSysOK.ProxyServer != "http://127.0.0.1:7890" {
		t.Fatalf("有效系统代理应放行: %+v", resSysOK)
	}

	// 7. tun 模式：关闭时 fail-closed，开启时 Direct=true。
	tunActive.Store(false)
	resTunOff, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeTUN},
	})
	if resTunOff.OK || resTunOff.Error != agyegress.ErrorTUNInactive {
		t.Fatalf("TUN 未激活应报错 %s: %+v", agyegress.ErrorTUNInactive, resTunOff)
	}
	tunActive.Store(true)
	resTunOn, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModeTUN},
	})
	if !resTunOn.OK || !resTunOn.Direct || resTunOn.Source != agyegress.ModeTUN {
		t.Fatalf("TUN 激活时应成功: %+v", resTunOn)
	}

	// 8. pool 模式：未启动时 fail-closed 返回 egress_pool_not_ready（绝不回落）；就绪时返回车道地址。
	resPoolDown, _ := mgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef, HasExplicit: true, NoAutoStart: true,
		ExplicitBinding: &agyegress.Binding{Mode: agyegress.ModePool},
	})
	if resPoolDown.OK || resPoolDown.Error != agyegress.ErrorPoolNotReady {
		t.Fatalf("pool 未就绪必须 fail-closed: %+v", resPoolDown)
	}

	coreBin := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, coreBin, 64)
	writeFakeProxyPoolNodes(t, dir, []map[string]any{
		{"id": "n1", "name": "US-Node-1", "protocol": "trojan", "server": "us1.example.com", "port": 443, "password": "pw", "countryCode": "US"},
	})
	rig := newMockMihomoRig(t, dir, false)
	lanePort := reserveLoopbackPort(t)
	poolMgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		Platform:             "darwin",
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       rig.port,
		ProbePort:            reserveLoopbackPort(t),
		LaneSlots:            1,
		LanePortBase:         lanePort,
		StartupTimeout:       1500 * time.Millisecond,
		StartupPollInterval:  10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error) {
			if err := rig.startListening(); err != nil {
				return nil, err
			}
			return newFakeCoreProcess(72001, rig.stopListening), nil
		},
		ProxyProbeFunc: func(_ context.Context, proxyURL string) ProxyProbeResult {
			return ProxyProbeResult{OK: true}
		},
	})
	defer func() { _ = poolMgr.Close() }()

	if _, err := agyegress.NewStore(dir).Replace(ctx, accRef, agyegress.ModePool, "", nil, "auto"); err != nil {
		t.Fatal(err)
	}
	if startRes := poolMgr.StartPool(ctx); !startRes.OK {
		t.Fatalf("StartPool failed: %+v", startRes)
	}
	poolMgr.health.RecordGeo("node-0", GeoLocation{Country: "US", IP: "1.1.1.1", At: nowMS})
	_ = poolMgr.ReconcileLanes(ctx)

	resPoolUp, _ := poolMgr.ResolveAccountEgress(ctx, ResolveAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if !resPoolUp.OK || resPoolUp.Source != agyegress.ModePool || resPoolUp.ProxyServer != fmt.Sprintf("http://127.0.0.1:%d", lanePort) {
		t.Fatalf("pool 就绪后应返回车道地址: %+v", resPoolUp)
	}
}

func TestApplyStoredAccountEgressAndRuntimeStatus(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()
	accRef := "acct_zcode_apply_0001"
	seedTestAccountRef(t, ctx, dir, accRef, "zcode", time.Now().UnixMilli())

	bridge := &mockDesktopBridge{}
	mgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		Platform:             "darwin",
		DesktopBridge:        bridge,
		DisableAutoDirectGeo: true,
		DisableProbeLoop:     true,
		ProxyProbeFunc: func(_ context.Context, proxyURL string) ProxyProbeResult {
			if strings.Contains(proxyURL, "9999") {
				return ProxyProbeResult{OK: false, Error: "proxy_unreachable", Reason: "probe_fail"}
			}
			return ProxyProbeResult{OK: true}
		},
	})
	defer func() { _ = mgr.Close() }()

	// 未运行桌面端 + 解绑 -> cleared；绑定 url -> applied。
	cleared := mgr.ApplyStoredAccountEgress(ctx, ApplyAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if !cleared.OK || !cleared.Applied || cleared.Status != "cleared" {
		t.Fatalf("解绑应用结果异常: %+v", cleared)
	}

	if _, err := agyegress.NewStore(dir).Replace(ctx, accRef, agyegress.ModeURL, "http://127.0.0.1:7890", nil, ""); err != nil {
		t.Fatal(err)
	}
	applied := mgr.ApplyStoredAccountEgress(ctx, ApplyAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if !applied.OK || !applied.Applied || applied.Status != "applied" || applied.Restarted {
		t.Fatalf("未运行桌面端应用 url 应返回 applied: %+v", applied)
	}

	// 桌面端正在运行（PID 3333）-> Close + Launch -> restarted。
	bridge.mu.Lock()
	bridge.runningPIDs = []int{3333}
	bridge.mu.Unlock()

	restarted := mgr.ApplyStoredAccountEgress(ctx, ApplyAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if !restarted.OK || !restarted.Applied || !restarted.Restarted || restarted.Status != "restarted" ||
		restarted.PID == nil || *restarted.PID <= 88000 || len(restarted.PreviousPIDs) != 1 || restarted.PreviousPIDs[0] != 3333 {
		t.Fatalf("运行中桌面端重启结果异常: %+v", restarted)
	}

	// GetAccountEgressRuntimeStatus 返回桌面 PID 与 resolved 信息。
	status := mgr.GetAccountEgressRuntimeStatus(ctx, RuntimeStatusOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if !status.OK || !status.Runtime.DesktopRunning || status.Runtime.DesktopPID == nil ||
		*status.Runtime.DesktopPID != *restarted.PID || status.Runtime.Resolved == nil || !status.Runtime.Resolved.OK {
		t.Fatalf("GetAccountEgressRuntimeStatus 异常: %+v", status)
	}

	// 关闭失败应返回 zcode_desktop_close_failed；启动失败返回 launch_failed。
	bridge.mu.Lock()
	bridge.closeErr = errors.New("kill_blocked")
	bridge.mu.Unlock()
	closeFail := mgr.ApplyStoredAccountEgress(ctx, ApplyAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if closeFail.OK || closeFail.Error != "zcode_desktop_close_failed" {
		t.Fatalf("关闭失败应返回 zcode_desktop_close_failed: %+v", closeFail)
	}

	bridge.mu.Lock()
	bridge.closeErr = nil
	bridge.runningPIDs = []int{4444}
	bridge.launchErr = errors.New("spawn_boom")
	bridge.mu.Unlock()
	launchFail := mgr.ApplyStoredAccountEgress(ctx, ApplyAccountEgressOptions{
		Provider: "zcode", AccountRef: accRef,
	})
	if launchFail.OK || launchFail.Error != "launch_failed" {
		t.Fatalf("拉起失败应返回 launch_failed: %+v", launchFail)
	}
}

func TestGatewayNetworkGuardAndTrafficEvidenceObserver(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()
	accRef := "acct_guard_claude_001"
	nowMS := time.Now().UnixMilli()
	seedTestAccountRef(t, ctx, dir, accRef, "claude", nowMS)

	var geoCountry atomic.Value
	geoCountry.Store("HK")
	geoClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			u := req.URL.String()
			c := geoCountry.Load().(string)
			switch {
			case strings.Contains(u, "ipify"):
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(strings.NewReader(`{"ip":"203.0.113.50"}`)),
					Header:     make(http.Header),
				}, nil
			case strings.Contains(u, "ipinfo.io/json"):
				payload, _ := json.Marshal(map[string]any{
					"ip": "203.0.113.50", "country": c, "region": "Test", "city": "City", "org": "AS13335 Test",
				})
				return &http.Response{
					StatusCode: 200,
					Body:       io.NopCloser(strings.NewReader(string(payload))),
					Header:     make(http.Header),
				}, nil
			default:
				return &http.Response{
					StatusCode: 404,
					Body:       io.NopCloser(strings.NewReader("")),
					Header:     make(http.Header),
				}, nil
			}
		}),
	}

	// 启动带一个池节点的管理器以配合 TrafficEvidenceObserver 检验车道与证据隔离。
	coreBin := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, coreBin, 64)
	writeFakeProxyPoolNodes(t, dir, []map[string]any{
		{"id": "n1", "name": "HK-1", "protocol": "trojan", "server": "hk1.example.com", "port": 443, "password": "pw", "countryCode": "HK"},
		{"id": "n2", "name": "US-1", "protocol": "trojan", "server": "us1.example.com", "port": 443, "password": "pw", "countryCode": "US"},
	})
	rig := newMockMihomoRig(t, dir, false)
	mgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       rig.port,
		ProbePort:            reserveLoopbackPort(t),
		LaneSlots:            1,
		LanePortBase:         reserveLoopbackPort(t),
		StartupTimeout:       1500 * time.Millisecond,
		StartupPollInterval:  10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		LocalGeoHTTPClient:   geoClient,
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error) {
			if err := rig.startListening(); err != nil {
				return nil, err
			}
			return newFakeCoreProcess(73001, rig.stopListening), nil
		},
	})
	defer func() { _ = mgr.Close() }()
	if _, err := agyegress.NewStore(dir).Replace(ctx, accRef, agyegress.ModePool, "", nil, "auto"); err != nil {
		t.Fatal(err)
	}
	if startRes := mgr.StartPool(ctx); !startRes.OK {
		t.Fatalf("StartPool failed: %+v", startRes)
	}
	mgr.health.RecordGeo("node-0", GeoLocation{Country: "HK", IP: "203.0.113.50", At: nowMS})
	mgr.health.RecordGeo("node-1", GeoLocation{Country: "US", IP: "198.51.100.1", At: nowMS})

	// 1. GatewayNetworkGuard：HK 出口被 Claude 拒绝；pool 源放行；切换为 US + Clear 后放行。
	guard := NewGatewayNetworkGuard(mgr)
	accRec := AccountRecord{AccountRef: accRef, Provider: "claude"}

	denial := guard.CheckGatewayNetwork(ctx, GatewayNetworkCheckInput{
		Account:      accRec,
		EgressSource: "url",
		ProxyURL:     "http://127.0.0.1:7890",
	})
	if denial == nil || !denial.Denied || denial.Error != "egress_region_denied" || !strings.Contains(denial.Reason, "HK") {
		t.Fatalf("HK 出口应触发地区拒绝，实际: %+v", denial)
	}
	if poolPass := guard.CheckGatewayNetwork(ctx, GatewayNetworkCheckInput{
		Account:      accRec,
		EgressSource: "pool",
	}); poolPass != nil {
		t.Fatalf("pool 来源应跳过直连网关地区拦截: %+v", poolPass)
	}
	// 切换到新的 US 出口地址并刷新 guard 决策缓存，应正常放行。
	geoCountry.Store("US")
	guard.Invalidate()
	if allowed := guard.CheckGatewayNetwork(ctx, GatewayNetworkCheckInput{
		Account:      accRec,
		EgressSource: "url",
		ProxyURL:     "http://127.0.0.1:7899",
	}); allowed != nil {
		t.Fatalf("US 出口应放行，实际: %+v", allowed)
	}

	// 验证 ListNetworkDeniedRefs 能识别未绑定（或 tun）账号在 HK 直连出口被拦截。
	geoCountry.Store("HK")
	_ = mgr.geoCache.GetExitGeo(ctx, "", mgr.geoCache.now(), 2000)
	guard.Invalidate()
	otherRef := "acct_guard_denied_002"
	seedTestAccountRef(t, ctx, dir, otherRef, "claude", nowMS)
	deniedRefs := guard.ListNetworkDeniedRefs(ctx)
	if !deniedRefs[otherRef] {
		t.Fatalf("ListNetworkDeniedRefs 应包含 HK 直连被拒账号 %q，实际: %+v", otherRef, deniedRefs)
	}

	// 2. TrafficEvidenceObserver：OnRegionDenied 仅写入 ScopeAccountUpstream（不污染未开启晋升的 ScopeProviderExit）且重排车道；
	// OnSuccess 在半衰期内去重写入实测证据。
	obs := NewTrafficEvidenceObserver(mgr, false)
	idNode1 := mgr.health.IdentityOf("node-1")
	if handled := obs.OnRegionDenied(ctx, TrafficEvidenceInput{
		Account:         accRec,
		NodeName:        "node-1",
		NodeID:          idNode1,
		RegionSignature: "http_451",
	}); !handled {
		t.Fatalf("OnRegionDenied 应返回 true")
	}
	scopedEv := mgr.evidence.ListEvidence(ctx, ScopedEvidenceQuery{AccountRef: accRef, UpstreamID: "api.anthropic.com"})
	if len(scopedEv) == 0 || scopedEv[0].Status != "blocked" || scopedEv[0].Scope != ScopeAccountUpstream {
		t.Fatalf("期望写入 ScopeAccountUpstream blocked 证据: %+v", scopedEv)
	}
	providerEv := mgr.evidence.ListEvidence(ctx, ScopedEvidenceQuery{Scope: ScopeProviderExit, UpstreamID: "api.anthropic.com"})
	if len(providerEv) != 0 {
		t.Fatalf("promoteProviderEvidence=false 时不应污染 ScopeProviderExit: %+v", providerEv)
	}

	// OnSuccess 连续两次只写入一条有效证据（半衰期去重）。
	obs.OnSuccess(ctx, TrafficEvidenceInput{
		Account:  AccountRecord{AccountRef: "acct_guard_success_003", Provider: "codex"},
		NodeName: "node-1",
		NodeID:   idNode1,
	})
	obs.OnSuccess(ctx, TrafficEvidenceInput{
		Account:  AccountRecord{AccountRef: "acct_guard_success_003", Provider: "codex"},
		NodeName: "node-1",
		NodeID:   idNode1,
	})
	okEv := mgr.evidence.ListEvidence(ctx, ScopedEvidenceQuery{AccountRef: "acct_guard_success_003"})
	if len(okEv) != 1 || okEv[0].Status != "ok" {
		t.Fatalf("OnSuccess 半衰期内应去重写入 1 条 ok 证据: %+v", okEv)
	}
}
