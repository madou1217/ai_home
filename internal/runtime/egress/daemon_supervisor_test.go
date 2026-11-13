package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

type fakeCoreProcess struct {
	pid     int
	done    chan struct{}
	once    sync.Once
	onStop  func()
	mu      sync.Mutex
	termCnt int
	killCnt int
	waitErr error
}

func newFakeCoreProcess(pid int, onStop func()) *fakeCoreProcess {
	return &fakeCoreProcess{
		pid:    pid,
		done:   make(chan struct{}),
		onStop: onStop,
	}
}

func (p *fakeCoreProcess) PID() int { return p.pid }

func (p *fakeCoreProcess) SignalTerm() error {
	p.mu.Lock()
	p.termCnt++
	p.mu.Unlock()
	p.stop(nil)
	return nil
}

func (p *fakeCoreProcess) Kill() error {
	p.mu.Lock()
	p.killCnt++
	p.mu.Unlock()
	p.stop(errors.New("killed"))
	return nil
}

func (p *fakeCoreProcess) Wait() error {
	<-p.done
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}

func (p *fakeCoreProcess) stop(err error) {
	p.once.Do(func() {
		p.mu.Lock()
		p.waitErr = err
		p.mu.Unlock()
		if p.onStop != nil {
			p.onStop()
		}
		close(p.done)
	})
}

func reserveLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func writeFakeProxyPoolNodes(t *testing.T, aiHomeDir string, nodes []map[string]any) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"version": 1,
		"nodes":   nodes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aiHomeDir, "proxy-pool.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeExecutablePlaceholder(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := make([]byte, size)
	for i := range data {
		data[i] = 'x'
	}
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
}

type mockMihomoRig struct {
	port      int
	aiHomeDir string

	mu            sync.Mutex
	server        *httptest.Server
	selected      map[string]string
	selectedCalls []string
	dnsOverride   map[string]string
	failDelayFor  map[string]bool
	versionOK     bool
	requireAuth   bool
}

func newMockMihomoRig(t *testing.T, aiHomeDir string, startListeningNow bool) *mockMihomoRig {
	t.Helper()
	port := reserveLoopbackPort(t)
	rig := &mockMihomoRig{
		port:         port,
		aiHomeDir:    aiHomeDir,
		selected:     map[string]string{"GLOBAL": "", "AIH-PROBE": "", "LANE-0": ""},
		dnsOverride:  map[string]string{},
		failDelayFor: map[string]bool{},
		versionOK:    true,
		requireAuth:  true,
	}
	if startListeningNow {
		if err := rig.startListening(); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(rig.stopListening)
	return rig
}

func (r *mockMihomoRig) startListening() error {
	r.mu.Lock()
	if r.server != nil {
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", r.port))
	if err != nil {
		return err
	}
	srv := httptest.NewUnstartedServer(http.HandlerFunc(r.serve))
	srv.Listener = ln
	srv.Start()

	r.mu.Lock()
	r.server = srv
	r.mu.Unlock()
	return nil
}

func (r *mockMihomoRig) stopListening() {
	r.mu.Lock()
	srv := r.server
	r.server = nil
	r.mu.Unlock()
	if srv != nil {
		srv.Close()
	}
}

func (r *mockMihomoRig) currentSecret() string {
	raw, err := os.ReadFile(filepath.Join(r.aiHomeDir, "run", "egress-pool", "config.json"))
	if err != nil {
		return ""
	}
	var doc struct {
		Secret string `json:"secret"`
	}
	_ = json.Unmarshal(raw, &doc)
	return doc.Secret
}

func (r *mockMihomoRig) serve(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	verOK := r.versionOK
	reqAuth := r.requireAuth
	r.mu.Unlock()

	if !verOK && req.URL.Path == "/version" {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if reqAuth {
		secret := r.currentSecret()
		if secret == "" || req.Header.Get("Authorization") != "Bearer "+secret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	}

	switch {
	case req.Method == http.MethodGet && req.URL.Path == "/version":
		_, _ = io.WriteString(w, `{"version":"1.18.0"}`)
	case req.Method == http.MethodGet && req.URL.Path == "/dns/query":
		name := req.URL.Query().Get("name")
		r.mu.Lock()
		ans, ok := r.dnsOverride[name]
		r.mu.Unlock()
		if !ok {
			ans = "93.184.216.34"
		}
		if ans == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"Status": 2, "Answer": []any{}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Status": 0,
			"Answer": []map[string]any{{"name": name + ".", "type": 1, "TTL": 60, "data": ans}},
		})
	case req.Method == http.MethodGet && req.URL.Path == "/proxies":
		r.mu.Lock()
		proxies := make(map[string]any, len(r.selected))
		for g, now := range r.selected {
			proxies[g] = map[string]any{"name": g, "now": now}
		}
		r.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"proxies": proxies})
	case req.Method == http.MethodPut && strings.HasPrefix(req.URL.Path, "/proxies/"):
		group := strings.TrimPrefix(req.URL.Path, "/proxies/")
		group, _ = url.PathUnescape(group)
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		r.mu.Lock()
		r.selected[group] = body.Name
		r.selectedCalls = append(r.selectedCalls, group+"="+body.Name)
		r.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case req.Method == http.MethodGet && strings.HasSuffix(req.URL.Path, "/delay"):
		nodeEsc := strings.TrimSuffix(strings.TrimPrefix(req.URL.Path, "/proxies/"), "/delay")
		node, _ := url.PathUnescape(nodeEsc)
		r.mu.Lock()
		fail := r.failDelayFor[node]
		r.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusGatewayTimeout)
			return
		}
		_, _ = io.WriteString(w, `{"delay":88}`)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func TestResolveMihomoCorePathPriorityAndValidation(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pathBin := filepath.Join(t.TempDir(), "bin")

	// 仅 PATH 下存在目录与 0 字节占位时，必须全部忽略并报错。
	if err := os.MkdirAll(filepath.Join(pathBin, "mihomo"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeExecutablePlaceholder(t, filepath.Join(pathBin, "clash-meta"), 0)

	if _, err := ResolveMihomoCorePath(CoreResolverOptions{
		AIHomeDir: dir,
		Platform:  "linux",
		PathEnv:   pathBin,
		PathSet:   true,
	}); err == nil || err.Error() != "egress_pool_core_not_found" {
		t.Fatalf("期望 egress_pool_core_not_found，实际: %v", err)
	}

	// PATH 有有效可执行文件时回落到 path。
	validClash := filepath.Join(pathBin, "clash")
	writeExecutablePlaceholder(t, validClash, 128)
	res, err := ResolveMihomoCorePath(CoreResolverOptions{
		AIHomeDir: dir,
		Platform:  "linux",
		PathEnv:   pathBin,
		PathSet:   true,
	})
	if err != nil || res.Source != "path" || res.Path != validClash {
		t.Fatalf("期望命中 PATH clash，实际: res=%+v err=%v", res, err)
	}

	// <aiHomeDir>/tools/mihomo 优先级最高。
	managed := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, managed, 256)
	res, err = ResolveMihomoCorePath(CoreResolverOptions{
		AIHomeDir: dir,
		Platform:  "linux",
		PathEnv:   pathBin,
		PathSet:   true,
	})
	if err != nil || res.Source != "managed" || res.Path != managed {
		t.Fatalf("期望优先命中 managed，实际: res=%+v err=%v", res, err)
	}

	// Windows 平台必须查找 mihomo.exe。
	winManaged := filepath.Join(dir, "tools", "mihomo.exe")
	writeExecutablePlaceholder(t, winManaged, 256)
	res, err = ResolveMihomoCorePath(CoreResolverOptions{
		AIHomeDir: dir,
		Platform:  "windows",
		PathEnv:   "",
		PathSet:   true,
	})
	if err != nil || res.Source != "managed" || res.Path != winManaged {
		t.Fatalf("期望命中 Windows managed，实际: res=%+v err=%v", res, err)
	}
}

func TestBuildEgressPoolConfigAndPhysicalInterface(t *testing.T) {
	t.Parallel()

	iface := ResolvePhysicalInterface(func() ([]NetInterfaceEntry, error) {
		return []NetInterfaceEntry{
			{Name: "lo0", IsLoopback: true, IPv4: []string{"127.0.0.1"}},
			{Name: "utun4", IPv4: []string{"198.18.0.1"}},
			{Name: "bridge0", IPv4: []string{"198.19.0.1"}},
			{Name: "en0", IPv4: []string{"192.168.1.42"}},
		}, nil
	})
	if iface != "en0" {
		t.Fatalf("ResolvePhysicalInterface = %q, want en0", iface)
	}

	if _, err := BuildEgressPoolConfig(PoolConfigInput{
		MixedPort:      18890,
		ControllerPort: 18891,
		Secret:         "sec",
		Nodes:          nil,
	}); err == nil || err.Error() != "egress_pool_no_usable_nodes" {
		t.Fatalf("空节点列表应报错 egress_pool_no_usable_nodes，实际 %v", err)
	}

	built, err := BuildEgressPoolConfig(PoolConfigInput{
		MixedPort:      18890,
		ControllerPort: 18891,
		ProbePort:      18892,
		LanePorts:      []int{18893, 18894},
		Secret:         "unit-secret",
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.42"}}}, nil
		},
		Nodes: []ProxyNode{
			{
				ID:       "n1",
				Name:     "US Node 1",
				Protocol: "ss",
				Server:   "us1.example.com",
				Port:     8388,
				Password: "pass",
				Raw:      map[string]any{"cipher": "aes-256-gcm"},
			},
			{
				ID:       "n2",
				Name:     "US Node 1", // 重名节点应自动去重命名
				Protocol: "trojan",
				Server:   "us2.example.com",
				Port:     443,
				Password: "tpw",
			},
		},
	})
	if err != nil {
		t.Fatalf("BuildEgressPoolConfig failed: %v", err)
	}
	if len(built.NodeNames) != 2 || built.NodeNames[0] == built.NodeNames[1] {
		t.Fatalf("期望生成 2 个不重名节点，实际: %+v", built.NodeNames)
	}
	if built.InterfaceName != "en0" {
		t.Fatalf("InterfaceName = %q, want en0", built.InterfaceName)
	}
	dnsCfg, _ := built.Config["dns"].(map[string]any)
	ns, _ := dnsCfg["nameserver"].([]string)
	if len(ns) < 3 || ns[0] != DNSUDPServers[0] {
		t.Fatalf("DNS nameserver 顺序异常（UDP 应在 DoH 前）: %+v", ns)
	}
	if !strings.Contains(built.YAMLText, "mixed-port: 18890") || !strings.Contains(built.YAMLText, "AIH-PROBE") || !strings.Contains(built.YAMLText, "LANE-1") {
		t.Fatalf("生成的 YAML 缺少关键字段:\n%s", built.YAMLText)
	}
}

func TestSessionLeaseConcurrencyReclaimAndOverflow(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ref := "acct_session_lease_01"
	urls := []string{"http://127.0.0.1:21001", "http://127.0.0.1:21002"}

	alive := map[int]bool{101: true, 102: true, 103: true}
	var mu sync.Mutex
	isAlive := func(pid int) bool {
		mu.Lock()
		defer mu.Unlock()
		return alive[pid]
	}

	l1 := AcquireSessionLane(dir, ref, urls, 101, isAlive, 1000)
	l2 := AcquireSessionLane(dir, ref, urls, 102, isAlive, 1001)
	if l1 == nil || l2 == nil || l1.Shared || l2.Shared || l1.Slot == l2.Slot {
		t.Fatalf("两路并发会话应独占不同槽位: l1=%+v l2=%+v", l1, l2)
	}

	// 同 PID 重入应复用同一槽位。
	l1Again := AcquireSessionLane(dir, ref, urls, 101, isAlive, 1002)
	if l1Again.Slot != l1.Slot || l1Again.Shared {
		t.Fatalf("同一 PID 应幂等复用原槽位: l1=%+v again=%+v", l1, l1Again)
	}

	// 槽位全满时第 3 个 PID 进入 Shared=true 轮询。
	l3 := AcquireSessionLane(dir, ref, urls, 103, isAlive, 1003)
	if !l3.Shared || l3.Slot != (103%len(urls)) {
		t.Fatalf("全满后应按 pid%%len 共享槽位: l3=%+v", l3)
	}

	// PID 101 退出后，PID 104 应原子回收其槽位。
	mu.Lock()
	alive[101] = false
	alive[104] = true
	mu.Unlock()

	l4 := AcquireSessionLane(dir, ref, urls, 104, isAlive, 1004)
	if l4.Shared || l4.Slot != l1.Slot {
		t.Fatalf("死亡 PID 的槽位应被回收为独占槽位 %d: l4=%+v", l1.Slot, l4)
	}

	statuses := DescribeSessionLeases(dir, ref, 2, isAlive)
	if len(statuses) != 2 || !statuses[0].Alive || statuses[0].PID != 104 || !statuses[1].Alive || statuses[1].PID != 102 {
		t.Fatalf("DescribeSessionLeases = %+v", statuses)
	}
}

func TestPoolSupervisorStartupErrorsOrphanReapAndLifecycle(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()

	coreBin := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, coreBin, 64)
	writeFakeProxyPoolNodes(t, dir, []map[string]any{
		{"id": "n1", "name": "US-Alpha", "protocol": "trojan", "server": "us-alpha.example.com", "port": 443, "password": "pw1"},
		{"id": "n2", "name": "JP-Beta", "protocol": "trojan", "server": "jp-beta.example.com", "port": 443, "password": "pw2"},
	})

	// 1. 控制端口已被外部进程占用（且无归属孤儿），必须拒绝 egress_pool_controller_port_in_use。
	busyRig := newMockMihomoRig(t, dir, true)
	busyRig.mu.Lock()
	busyRig.requireAuth = false
	busyRig.mu.Unlock()

	busyMgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       busyRig.port,
		ProbePort:            reserveLoopbackPort(t),
		LaneSlots:            1,
		LanePortBase:         reserveLoopbackPort(t),
		StartupTimeout:       time.Second,
		StartupPollInterval:  10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error) {
			t.Fatal("控制端口被占用时不应用 spawnCore")
			return nil, nil
		},
	})
	if res := busyMgr.StartPool(ctx); res.OK || res.Error != "egress_pool_controller_port_in_use" {
		t.Fatalf("控制端口占用应拒绝启动: %+v", res)
	}
	_ = busyMgr.Close()
	busyRig.stopListening()

	// 2. 孤儿内核清理验证：旧 state.json 指向已退出的 ownerPID + 存活的 orphanPID，
	// Mock 监听旧端口；KillPID 被触发后释放端口并移除旧 state.json，随后启动新内核。
	orphanRig := newMockMihomoRig(t, dir, true)
	orphanRig.mu.Lock()
	orphanRig.requireAuth = false
	orphanRig.mu.Unlock()

	rig := newMockMihomoRig(t, dir, false)
	mixedPort := reserveLoopbackPort(t)
	probePort := reserveLoopbackPort(t)

	orphanPID := 424201
	var killedPIDs []int
	alivePIDs := map[int]bool{orphanPID: true}
	var pidMu sync.Mutex

	orphanState, _ := json.Marshal(PoolStateFile{
		Version:        stateFileVersion,
		OwnerPID:       999999,
		CorePID:        orphanPID,
		ProxyURL:       fmt.Sprintf("http://127.0.0.1:%d", mixedPort),
		ControllerPort: orphanRig.port,
		Secret:         "orphan-sec",
		StartedAt:      1000,
	})
	_ = writeStateFileAtomic(dir, orphanState)

	spawnCount := 0
	var currentProc *fakeCoreProcess
	mgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            mixedPort,
		ControllerPort:       rig.port,
		ProbePort:            probePort,
		LaneSlots:            2,
		LanePortBase:         reserveLoopbackPort(t),
		StartupTimeout:       1500 * time.Millisecond,
		StartupPollInterval:  10 * time.Millisecond,
		ReapTimeout:          300 * time.Millisecond,
		StartRetryBackoff:    10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		OwnerPID:             os.Getpid(),
		PIDAlive: func(pid int) bool {
			pidMu.Lock()
			defer pidMu.Unlock()
			return alivePIDs[pid]
		},
		KillPID: func(pid int) error {
			pidMu.Lock()
			killedPIDs = append(killedPIDs, pid)
			alivePIDs[pid] = false
			pidMu.Unlock()
			if pid == orphanPID {
				orphanRig.stopListening()
			}
			return nil
		},
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error) {
			spawnCount++
			if err := rig.startListening(); err != nil {
				return nil, err
			}
			pid := 50000 + spawnCount
			p := newFakeCoreProcess(pid, func() {
				pidMu.Lock()
				alivePIDs[pid] = false
				pidMu.Unlock()
				rig.stopListening()
			})
			pidMu.Lock()
			alivePIDs[pid] = true
			pidMu.Unlock()
			currentProc = p
			return p, nil
		},
	})
	defer func() { _ = mgr.Close() }()

	// 先测 DNS fake-ip 拦截：会先 reap 孤儿进程，然后启动子进程做 DNS 校验并拦截 fake-ip。
	rig.mu.Lock()
	rig.dnsOverride["us-alpha.example.com"] = "198.18.0.2"
	rig.mu.Unlock()

	resFakeIP := mgr.StartPool(ctx)
	if resFakeIP.OK || resFakeIP.Error != "egress_pool_dns_fake_ip" {
		t.Fatalf("DNS 返回 fake-ip 段必须拦截，实际: %+v", resFakeIP)
	}
	if len(killedPIDs) != 1 || killedPIDs[0] != orphanPID {
		t.Fatalf("孤儿进程 %d 应已被清理，killed=%+v", orphanPID, killedPIDs)
	}

	// 3. 恢复正常 DNS 解析，并且把节点 0 置冷却：启动后应自动选到 JP-Beta。
	mgr.health.BindNamedEntries([]RuntimeNodeEntry{
		{Name: "node-0", Protocol: "trojan", Server: "us-alpha.example.com", Port: 443},
		{Name: "node-1", Protocol: "trojan", Server: "jp-beta.example.com", Port: 443},
	})
	if cd := mgr.health.RecordFailure("node-0", "network", "", "", 0); cd <= 0 {
		t.Fatalf("RecordFailure(node-0, network) 应返回正冷却时间，实际 %d", cd)
	}
	rig.mu.Lock()
	delete(rig.dnsOverride, "us-alpha.example.com")
	rig.mu.Unlock()

	resOK := mgr.StartPool(ctx)
	if !resOK.OK || resOK.NodeCount != 2 || !mgr.IsPoolReady() {
		t.Fatalf("期望启动成功，实际: %+v ready=%v", resOK, mgr.IsPoolReady())
	}
	rig.mu.Lock()
	selectedGlobal := rig.selected["GLOBAL"]
	rig.mu.Unlock()
	if selectedGlobal != "node-1" {
		t.Fatalf("首节点冷却时启动应自动切到 node-1，实际 GLOBAL=%q", selectedGlobal)
	}
	state, err := ReadPoolStateFile(dir)
	if err != nil || state == nil || state.CorePID != currentProc.PID() {
		t.Fatalf("state.json 未正确写入: state=%+v err=%v", state, err)
	}

	// 4. StopPool 应终止子进程并删除 state.json。
	mgr.StopPool()
	if mgr.IsPoolReady() {
		t.Fatalf("StopPool 后 IsPoolReady 应为 false")
	}
	if _, err := os.Stat(filepath.Join(dir, "run", "egress-pool", "state.json")); !os.IsNotExist(err) {
		t.Fatalf("StopPool 后应清理 state.json，err=%v", err)
	}

	// 5. 子进程启动后早退应报 egress_pool_core_exited。
	exitedMgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       reserveLoopbackPort(t),
		ProbePort:            reserveLoopbackPort(t),
		LaneSlots:            2,
		LanePortBase:         reserveLoopbackPort(t),
		StartupTimeout:       2 * time.Second,
		StartupPollInterval:  10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		InterfacesFunc: func() ([]NetInterfaceEntry, error) {
			return []NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(ctx context.Context, binaryPath string, args []string) (CoreProcess, error) {
			p := newFakeCoreProcess(60001, nil)
			p.stop(errors.New("boom"))
			return p, nil
		},
	})
	defer func() { _ = exitedMgr.Close() }()
	resExit := exitedMgr.StartPool(ctx)
	if resExit.OK || resExit.Error != "egress_pool_core_exited" {
		t.Fatalf("子进程早退应返回 egress_pool_core_exited，实际: %+v", resExit)
	}
}

func TestManagerDaemonConditionalAutoStartAndClose(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()

	coreBin := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, coreBin, 64)
	writeFakeProxyPoolNodes(t, dir, []map[string]any{
		{"id": "n1", "name": "US-Node-1", "protocol": "trojan", "server": "us1.example.com", "port": 443, "password": "pw1"},
	})

	rig := newMockMihomoRig(t, dir, false)
	var spawned atomic.Int32
	opts := ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       rig.port,
		ProbePort:            reserveLoopbackPort(t),
		LaneSlots:            1,
		LanePortBase:         reserveLoopbackPort(t),
		StartupTimeout:       1500 * time.Millisecond,
		StartupPollInterval:  10 * time.Millisecond,
		PlanInterval:         20 * time.Millisecond,
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
			n := int(spawned.Add(1))
			return newFakeCoreProcess(70000+n, rig.stopListening), nil
		},
	}

	// 无 pool 绑定时 Start 不应拉起内核。
	mgrNoPool := NewManager(opts)
	if err := mgrNoPool.Start(ctx); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	time.Sleep(40 * time.Millisecond)
	if spawned.Load() != 0 || mgrNoPool.IsPoolReady() {
		t.Fatalf("无 pool 绑定时不应自动启动 mihomo")
	}
	if err := mgrNoPool.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	// 存在未退役 pool 绑定时，Start 自动拉起内核，Close 停止并清理。
	accRef := "acct_11112222333344445555"
	seedTestAccountRef(t, ctx, dir, accRef, "zcode", 1000)
	if _, err := agyegress.NewStore(dir).Replace(ctx, accRef, agyegress.ModePool, "", nil, "auto"); err != nil {
		t.Fatal(err)
	}

	mgrWithPool := NewManager(opts)
	if err := mgrWithPool.Start(ctx); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !mgrWithPool.IsPoolReady() {
		time.Sleep(15 * time.Millisecond)
	}
	if !mgrWithPool.IsPoolReady() || spawned.Load() != 1 {
		t.Fatalf("存在 pool 绑定时 Start 应自动拉起内核, ready=%v spawned=%d", mgrWithPool.IsPoolReady(), spawned.Load())
	}
	if err := mgrWithPool.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	if mgrWithPool.IsPoolReady() {
		t.Fatalf("Close 后 IsPoolReady 应为 false")
	}
}

func TestMaintenanceTickRotationCooldownAndProxyURLFailClosed(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()

	coreBin := filepath.Join(dir, "tools", "mihomo")
	writeExecutablePlaceholder(t, coreBin, 64)
	writeFakeProxyPoolNodes(t, dir, []map[string]any{
		{"id": "n1", "name": "HK-Blocked", "protocol": "trojan", "server": "n1.example.com", "port": 443, "password": "pw1"},
		{"id": "n2", "name": "US-Good-1", "protocol": "trojan", "server": "n2.example.com", "port": 443, "password": "pw2"},
		{"id": "n3", "name": "US-Good-2", "protocol": "trojan", "server": "n3.example.com", "port": 443, "password": "pw3"},
	})

	rig := newMockMihomoRig(t, dir, false)

	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rig.mu.Lock()
		probeNode := rig.selected["AIH-PROBE"]
		rig.mu.Unlock()
		if probeNode == "node-0" {
			w.WriteHeader(http.StatusUnavailableForLegalReasons)
			_, _ = io.WriteString(w, `{"error":"country not supported"}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
	}))
	defer upstreamSrv.Close()

	probeLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	probePort := probeLn.Addr().(*net.TCPAddr).Port
	probeSrv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		rig.mu.Lock()
		probeNode := rig.selected["AIH-PROBE"]
		rig.mu.Unlock()

		if strings.Contains(r.URL.String(), "ip-api.com") {
			country, region, city, ip := "HK", "Hong Kong", "Hong Kong", "203.0.113.10"
			switch probeNode {
			case "node-1":
				country, region, city, ip = "US", "California", "Los Angeles", "198.51.100.20"
			case "node-2":
				country, region, city, ip = "US", "Virginia", "Ashburn", "198.51.100.30"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":      "success",
				"countryCode": country,
				"regionName":  region,
				"city":        city,
				"as":          "AS13335 Cloudflare",
				"isp":         "Cloudflare",
				"query":       ip,
			})
			return
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), nil)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))
	probeSrv.Listener = probeLn
	probeSrv.Start()
	defer probeSrv.Close()

	accRef := "acct_abcdefabcdefabcdef12"
	nowMS := time.Now().UnixMilli()
	seedTestAccountRef(t, ctx, dir, accRef, "claude", nowMS)
	_ = writeJSONKV(ctx, dir, serverConfigKey, map[string]any{
		"claude_base_url": upstreamSrv.URL,
	}, nowMS)
	if _, err := agyegress.NewStore(dir).Replace(ctx, accRef, agyegress.ModePool, "", nil, "auto"); err != nil {
		t.Fatal(err)
	}

	lanePort := reserveLoopbackPort(t)
	mgrRef := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		MixedPort:            reserveLoopbackPort(t),
		ControllerPort:       rig.port,
		ProbePort:            probePort,
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
			return newFakeCoreProcess(71001, rig.stopListening), nil
		},
	})
	defer func() { _ = mgrRef.Close() }()

	if res := mgrRef.StartPool(ctx); !res.OK {
		t.Fatalf("StartPool failed: %+v", res)
	}

	// 启动前未查归属地，执行一次维护后应补齐 3 个 Geo 并执行上游实测，自动淘汰 node-0、分配 US 合规节点 node-1！
	maint := mgrRef.MaintenanceTick(ctx, MaintenanceOptions{GeoLimit: 3, ProbeLimit: 6})
	if maint.Geo != 3 || maint.Probes < 1 {
		t.Fatalf("MaintenanceTick 应补齐 3 个 Geo 与至少 1 次实测: %+v", maint)
	}
	if curNode := mgrRef.CurrentAccountPoolNode(ctx, accRef); curNode != "node-1" {
		t.Fatalf("期望维护后账号分配到 US 合规节点 node-1，实际: %q", curNode)
	}
	proxyURL := mgrRef.CurrentAccountProxyURL(ctx, accRef, false)
	if proxyURL != fmt.Sprintf("http://127.0.0.1:%d", lanePort) {
		t.Fatalf("CurrentAccountProxyURL = %q, want lane port %d", proxyURL, lanePort)
	}

	// Session=true 应走同一 lane URL 并记录租约（单 URL 时 slot=0）。
	sessURL := mgrRef.CurrentAccountProxyURL(ctx, accRef, true)
	if sessURL != proxyURL {
		t.Fatalf("CurrentAccountProxyURL(session) = %q, want %q", sessURL, proxyURL)
	}

	// ip_blocked 不应触发节点全局冷却，network 才触发冷却；success 清除冷却。
	mgrRef.RecordNodeOutcome(ctx, "node-1", false, "ip_blocked", accRef, "claude", 0)
	if mgrRef.health.IsCooling("node-1", mgrRef.nowMS()) {
		t.Fatalf("ip_blocked 不应触发节点全局冷却")
	}
	mgrRef.RecordNodeOutcome(ctx, "node-1", false, "network", accRef, "claude", 0)
	if !mgrRef.health.IsCooling("node-1", mgrRef.nowMS()) {
		t.Fatalf("network 故障应触发节点冷却")
	}
	// RecordNodeOutcome(false, "network") 同时已触发对 node-1 所在车道的自动轮换（切到 node-2）。
	if afterFailNode := mgrRef.CurrentAccountPoolNode(ctx, accRef); afterFailNode != "node-2" {
		t.Fatalf("node-1 网络故障冷却后应自动轮换账号车道到 node-2，实际: %q", afterFailNode)
	}
	mgrRef.RecordNodeOutcome(ctx, "node-1", true, "", accRef, "claude", 0)
	if mgrRef.health.IsCooling("node-1", mgrRef.nowMS()) {
		t.Fatalf("success 应立即解除节点冷却")
	}

	// RotatePoolNode 切走 GLOBAL；RotateAccountLane 从 node-2 轮换到 node-1。
	if next := mgrRef.RotatePoolNode(ctx, "node-0", "test_rotate"); next != "node-1" {
		t.Fatalf("RotatePoolNode(node-0) = %q, want node-1", next)
	}
	if laneNext := mgrRef.RotateAccountLane(ctx, accRef, "node-2", "manual_rotate"); laneNext != "node-1" {
		t.Fatalf("RotateAccountLane(node-2) = %q, want node-1", laneNext)
	}

	// Overflow / 阻断场景（不同上游触发第 2 条共享车道 > LaneSlots=1）必须 fail-closed 返回空代理地址与原因描述。
	otherRef := "acct_overflow_0000000001"
	seedTestAccountRef(t, ctx, dir, otherRef, "codex", nowMS)
	_, _ = agyegress.NewStore(dir).Replace(ctx, otherRef, agyegress.ModePool, "", nil, "auto")
	_ = mgrRef.ReconcileLanes(ctx)
	if got := mgrRef.CurrentAccountProxyURL(ctx, otherRef, false); got != "" {
		t.Fatalf("溢出车道账号必须 fail-closed 返回空串，实际: %q", got)
	}
	if reason := mgrRef.DescribePoolUnavailable(ctx, otherRef); !strings.Contains(reason, "overflow") {
		t.Fatalf("期望溢出原因说明，实际: %q", reason)
	}
}
