package webuiaccountegressapi

import (
	"context"
	"database/sql"
	"encoding/json"
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

	"github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	_ "modernc.org/sqlite"
)

type stubDesktopBridge struct {
	mu      sync.Mutex
	pid     int
	running bool
}

func (b *stubDesktopBridge) InspectRunning(_ context.Context, _ string, _ string) (runtimeegress.DesktopInspectResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.running && b.pid > 0 {
		return runtimeegress.DesktopInspectResult{OK: true, Status: "already_running", PIDs: []int{b.pid}}, nil
	}
	return runtimeegress.DesktopInspectResult{OK: true, Status: "not_running"}, nil
}

func (b *stubDesktopBridge) CloseApp(_ context.Context, _ string, _ string) (runtimeegress.DesktopInspectResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.running = false
	return runtimeegress.DesktopInspectResult{OK: true, Status: "closed"}, nil
}

func (b *stubDesktopBridge) LaunchApp(_ context.Context, _ string, _ string, _ *runtimeegress.EgressResolveResult) (runtimeegress.DesktopRestartResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pid += 10
	b.running = true
	return runtimeegress.DesktopRestartResult{OK: true, Status: "launched", PID: b.pid}, nil
}

type fakeRuntimeCoreProc struct {
	pid    int
	done   chan struct{}
	once   sync.Once
	onStop func()
}

func (p *fakeRuntimeCoreProc) PID() int { return p.pid }
func (p *fakeRuntimeCoreProc) SignalTerm() error {
	p.once.Do(func() {
		if p.onStop != nil {
			p.onStop()
		}
		close(p.done)
	})
	return nil
}
func (p *fakeRuntimeCoreProc) Kill() error { return p.SignalTerm() }
func (p *fakeRuntimeCoreProc) Wait() error { <-p.done; return nil }

type recordingPoolCtrl struct {
	inner     *runtimeegress.Manager
	startCnt  atomic.Int32
	reconcCnt atomic.Int32
}

func (r *recordingPoolCtrl) StartPool(ctx context.Context) runtimeegress.PoolStartResult {
	r.startCnt.Add(1)
	return r.inner.StartPool(ctx)
}

func (r *recordingPoolCtrl) ReconcileLanes(ctx context.Context) error {
	r.reconcCnt.Add(1)
	return r.inner.ReconcileLanes(ctx)
}

func newRuntimeTestMux(t *testing.T, aiHomeDir string, mgr *runtimeegress.Manager, pool PoolController) http.Handler {
	t.Helper()
	deps := Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Catalog:    newCatalog(t),
		Store:      egress.NewStore(aiHomeDir),
		Runtime:    mgr,
		Pool:       pool,
	}
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/egress", handler)
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/egress", handler)
	return mux
}

func TestRuntimeHandlerGetAndPostPoolApply(t *testing.T) {
	aiHomeDir := seed(t)

	// 创建假 mihomo 可执行文件与节点池
	toolsDir := filepath.Join(aiHomeDir, "tools")
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(toolsDir, "mihomo"), []byte("core"), 0o755); err != nil {
		t.Fatal(err)
	}
	nodesRaw, _ := json.Marshal(map[string]any{
		"version": 1,
		"nodes": []map[string]any{
			{"id": "n1", "name": "US-Node", "protocol": "trojan", "server": "us.example.com", "port": 443, "password": "pw", "countryCode": "US"},
		},
	})
	if err := os.WriteFile(filepath.Join(aiHomeDir, "proxy-pool.json"), nodesRaw, 0o600); err != nil {
		t.Fatal(err)
	}

	reservePort := func() int {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		_ = ln.Close()
		return port
	}
	ctrlPort := reservePort()
	lanePort := reservePort()
	var srvMu sync.Mutex
	var ctrlSrv *httptest.Server
	selected := map[string]string{"GLOBAL": "", "AIH-PROBE": "", "LANE-0": ""}

	startMockCtrl := func() error {
		srvMu.Lock()
		defer srvMu.Unlock()
		if ctrlSrv != nil {
			return nil
		}
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ctrlPort))
		if err != nil {
			return err
		}
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rawCfg, _ := os.ReadFile(filepath.Join(aiHomeDir, "run", "egress-pool", "config.json"))
			var doc struct {
				Secret string `json:"secret"`
			}
			_ = json.Unmarshal(rawCfg, &doc)
			if doc.Secret == "" || r.Header.Get("Authorization") != "Bearer "+doc.Secret {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			switch {
			case r.URL.Path == "/version":
				_, _ = io.WriteString(w, `{"version":"1.18.0"}`)
			case r.URL.Path == "/dns/query":
				_ = json.NewEncoder(w).Encode(map[string]any{
					"Status": 0,
					"Answer": []map[string]any{{"name": "us.example.com.", "type": 1, "TTL": 60, "data": "93.184.216.34"}},
				})
			case r.Method == http.MethodGet && r.URL.Path == "/proxies":
				srvMu.Lock()
				proxies := map[string]any{}
				for k, v := range selected {
					proxies[k] = map[string]any{"name": k, "now": v}
				}
				srvMu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]any{"proxies": proxies})
			case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/proxies/"):
				grp, _ := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/proxies/"))
				var body struct{ Name string `json:"name"` }
				_ = json.NewDecoder(r.Body).Decode(&body)
				srvMu.Lock()
				selected[grp] = body.Name
				srvMu.Unlock()
				w.WriteHeader(http.StatusNoContent)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		srv.Listener = ln
		srv.Start()
		ctrlSrv = srv
		return nil
	}
	stopMockCtrl := func() {
		srvMu.Lock()
		srv := ctrlSrv
		ctrlSrv = nil
		srvMu.Unlock()
		if srv != nil {
			srv.Close()
		}
	}
	t.Cleanup(stopMockCtrl)

	bridge := &stubDesktopBridge{pid: 2220, running: true}
	mgr := runtimeegress.NewManager(runtimeegress.ManagerOptions{
		AIHomeDir:            aiHomeDir,
		Platform:             "darwin",
		MixedPort:            reservePort(),
		ControllerPort:       ctrlPort,
		ProbePort:            reservePort(),
		LaneSlots:            1,
		LanePortBase:         lanePort,
		StartupTimeout:       1500 * time.Millisecond,
		StartupPollInterval:  10 * time.Millisecond,
		DisableSwitchSettle:  true,
		DisableProbeLoop:     true,
		DisableAutoDirectGeo: true,
		DesktopBridge:        bridge,
		InterfacesFunc: func() ([]runtimeegress.NetInterfaceEntry, error) {
			return []runtimeegress.NetInterfaceEntry{{Name: "en0", IPv4: []string{"192.168.1.50"}}}, nil
		},
		SpawnCore: func(_ context.Context, _ string, _ []string) (runtimeegress.CoreProcess, error) {
			if err := startMockCtrl(); err != nil {
				return nil, err
			}
			return &fakeRuntimeCoreProc{pid: 81001, done: make(chan struct{}), onStop: stopMockCtrl}, nil
		},
		ProxyProbeFunc: func(_ context.Context, proxyURL string) runtimeegress.ProxyProbeResult {
			if strings.Contains(proxyURL, "dead") || strings.Contains(proxyURL, "9999") {
				return runtimeegress.ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "unreachable"}
			}
			return runtimeegress.ProxyProbeResult{OK: true}
		},
	})
	defer func() { _ = mgr.Close() }()

	poolRec := &recordingPoolCtrl{inner: mgr}
	mux := newRuntimeTestMux(t, aiHomeDir, mgr, poolRec)

	// 1. POST pool 模式：应调用 StartPool + ReconcileLanes，重排并启动桌面客户端返回 runtime + assignment + apply。
	rec, payload := post(t, mux, Path+"/zcode/"+accountRef+"/egress", map[string]any{"mode": "pool"})
	if rec.Code != http.StatusOK || payload["ok"] != true {
		t.Fatalf("POST pool failed status=%d payload=%#v", rec.Code, payload)
	}
	if poolRec.startCnt.Load() == 0 || poolRec.reconcCnt.Load() == 0 {
		t.Fatalf("POST pool 必须触发 StartPool 和 ReconcileLanes: start=%d reconcile=%d", poolRec.startCnt.Load(), poolRec.reconcCnt.Load())
	}
	applyObj, _ := payload["apply"].(map[string]any)
	wantProxy := fmt.Sprintf("http://127.0.0.1:%d", lanePort)
	if applyObj["ok"] != true || applyObj["status"] != "restarted" || applyObj["proxyServer"] != wantProxy {
		t.Fatalf("POST pool apply=%#v want proxyServer=%s", applyObj, wantProxy)
	}
	if assignmentObj, _ := payload["assignment"].(map[string]any); assignmentObj == nil {
		t.Fatalf("POST pool 响应缺少 assignment: %#v", payload)
	}

	// 2. GET 携带完整 runtime 与 assignment。
	recGet, getPayload := get(t, mux, Path+"/zcode/"+accountRef+"/egress")
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET status=%d payload=%#v", recGet.Code, getPayload)
	}
	rtObj, _ := getPayload["runtime"].(map[string]any)
	if rtObj["desktopRunning"] != true || rtObj["desktopPid"] == nil {
		t.Fatalf("GET runtime 缺少桌面进程信息: %#v", rtObj)
	}
	resolvedObj, _ := rtObj["resolved"].(map[string]any)
	if resolvedObj["ok"] != true || resolvedObj["source"] != "pool" || resolvedObj["proxyServer"] != wantProxy {
		t.Fatalf("GET runtime.resolved=%#v", resolvedObj)
	}
}

func TestRuntimeHandlerRollbackAndRetiredNoRollback(t *testing.T) {
	aiHomeDir := seed(t)
	bridge := &stubDesktopBridge{}
	var failProbePort atomic.Int32
	failProbePort.Store(9999)

	mgr := runtimeegress.NewManager(runtimeegress.ManagerOptions{
		AIHomeDir:            aiHomeDir,
		Platform:             "darwin",
		DesktopBridge:        bridge,
		DisableAutoDirectGeo: true,
		DisableProbeLoop:     true,
		ProxyProbeFunc: func(_ context.Context, proxyURL string) runtimeegress.ProxyProbeResult {
			badPort := fmt.Sprintf(":%d", failProbePort.Load())
			if strings.Contains(proxyURL, badPort) {
				return runtimeegress.ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "bad_port"}
			}
			return runtimeegress.ProxyProbeResult{OK: true}
		},
	})
	defer func() { _ = mgr.Close() }()

	mux := newRuntimeTestMux(t, aiHomeDir, mgr, mgr)

	// 1. 原未绑定 -> POST 失败 url（9999）-> 应自动回滚清除绑定且 rolledBack=true。
	rec1, p1 := post(t, mux, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode":     "url",
		"proxyUrl": "http://127.0.0.1:9999",
	})
	if rec1.Code != http.StatusOK || p1["binding"] != nil {
		t.Fatalf("从空绑定回滚后 binding 应为 nil，实际 status=%d payload=%#v", rec1.Code, p1)
	}
	apply1, _ := p1["apply"].(map[string]any)
	if apply1["ok"] != false || apply1["rolledBack"] != true {
		t.Fatalf("回滚标记异常: %#v", apply1)
	}

	// 2. 先绑定可用 url（7890），再改为坏 url（9999）-> 自动恢复 7890。
	recGood, pGood := post(t, mux, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode":     "url",
		"proxyUrl": "http://127.0.0.1:7890",
	})
	if recGood.Code != http.StatusOK || pGood["apply"].(map[string]any)["ok"] != true {
		t.Fatalf("设置有效 url 失败: %#v", pGood)
	}
	rec2, p2 := post(t, mux, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode":     "url",
		"proxyUrl": "http://127.0.0.1:9999",
	})
	if rec2.Code != http.StatusOK {
		t.Fatalf("status=%d", rec2.Code)
	}
	b2, _ := p2["binding"].(map[string]any)
	apply2, _ := p2["apply"].(map[string]any)
	if b2["proxyUrl"] != "http://127.0.0.1:7890" || apply2["rolledBack"] != true {
		t.Fatalf("应恢复到 7890 且 rolledBack=true: binding=%#v apply=%#v", b2, apply2)
	}

	// 3. 当回滚重新 apply 原绑定也失败时（7890 也不可达），rolledBack=false 且带 rollbackError。
	failProbePort.Store(7890)
	// 先把 fail 对 9999 也拒绝：借助新 mgr 两个端口都拒，直接注入不可达端口。
	bothBadMgr := runtimeegress.NewManager(runtimeegress.ManagerOptions{
		AIHomeDir:            aiHomeDir,
		Platform:             "darwin",
		DesktopBridge:        bridge,
		DisableAutoDirectGeo: true,
		DisableProbeLoop:     true,
		ProxyProbeFunc: func(_ context.Context, _ string) runtimeegress.ProxyProbeResult {
			return runtimeegress.ProxyProbeResult{OK: false, Error: "proxy_probe_failed", Reason: "all_down"}
		},
	})
	defer func() { _ = bothBadMgr.Close() }()
	muxBothBad := newRuntimeTestMux(t, aiHomeDir, bothBadMgr, bothBadMgr)
	_, pBoth := post(t, muxBothBad, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode":     "url",
		"proxyUrl": "http://127.0.0.1:9999",
	})
	applyBoth, _ := pBoth["apply"].(map[string]any)
	if applyBoth["rolledBack"] != false || applyBoth["rollbackError"] == nil {
		t.Fatalf("双向均失败时应标记 rolledBack=false 且含 rollbackError: %#v", applyBoth)
	}

	// 4. 若 previous.retired == true，即使新绑定 apply 失败，也绝不回写已退役记录。
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT OR REPLACE INTO app_kv VALUES (?, ?, 1)", "account:egress:"+accountRef, `{"mode":"node","nodeId":"legacy-n1"}`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	_, pRet := post(t, muxBothBad, Path+"/zcode/"+accountRef+"/egress", map[string]any{
		"mode":     "url",
		"proxyUrl": "http://127.0.0.1:8888",
	})
	bRet, _ := pRet["binding"].(map[string]any)
	applyRet, _ := pRet["apply"].(map[string]any)
	if bRet["mode"] != "url" || bRet["proxyUrl"] != "http://127.0.0.1:8888" {
		t.Fatalf("previous 为已退役记录时不得回滚恢复旧 mode: %#v", pRet)
	}
	if _, hasRB := applyRet["rolledBack"]; hasRB {
		t.Fatalf("previous.retired==true 不应执行回滚: %#v", applyRet)
	}
}
