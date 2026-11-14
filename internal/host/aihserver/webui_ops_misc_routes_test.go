package aihserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/runtime/codexresetcredit"
	"github.com/madou1217/ai_home/internal/runtime/taskhub"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountactivityapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountegressapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuialiaspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelcontextapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverrestartapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwindowactivationapi"
)

type stubOpsAuthorizer struct{ allow bool }

func (a stubOpsAuthorizer) Authorized(*http.Request) bool { return a.allow }

type stubActivityLister struct{}

func (stubActivityLister) ListByProvider(context.Context, string) ([]string, error) {
	return nil, nil
}

type stubCodexTransport struct{}

func (stubCodexTransport) AssertOAuthAccount(context.Context, string) error { return nil }
func (stubCodexTransport) ReadRateLimits(context.Context, string) (map[string]any, error) {
	return map[string]any{}, nil
}
func (stubCodexTransport) ConsumeCredit(context.Context, string, string, string) (map[string]any, error) {
	return map[string]any{}, nil
}

type stubServerRestarter struct {
	called bool
}

func (s *stubServerRestarter) Restart(_ context.Context, _ webuiserverrestartapi.RestartJob) (webuiserverrestartapi.RestartOutcome, error) {
	s.called = true
	return webuiserverrestartapi.RestartOutcome{PID: 4242}, nil
}

func TestBuildWebUIOpsMiscRoutes_NoServeMuxConflictsAndWorksEndToEnd(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	peerPending := filepath.Join(aiHome, "run", "peer", "pending")
	if err := os.MkdirAll(peerPending, 0o755); err != nil {
		t.Fatalf("mkdir peer pending: %v", err)
	}
	if err := os.WriteFile(filepath.Join(peerPending, "pm-1.json"), []byte(`{"id":"pm-1","body":"hello","state":"pending","createdAt":1700000000000}`), 0o600); err != nil {
		t.Fatalf("write peer message: %v", err)
	}

	hub := taskhub.NewHub()
	activityJobs := accountactivity.NewJobManager(time.Now, taskhub.AccountActivityChangedHandler(hub))
	noop := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	mux := http.NewServeMux()
	// 预先挂载现有 /v1/management/webui/accounts/{provider}/{accountRef}/... 路由，验证无 ServeMux 冲突。
	for _, pattern := range []string{
		"GET " + webuiquotaresetapi.Path + "/{provider}/{accountRef}/quota-reset-events",
		"GET " + webuialiaspoolapi.Path + "/{provider}/{accountRef}/alias-pool",
		"POST " + webuialiaspoolapi.Path + "/{provider}/{accountRef}/alias-pool",
		"GET " + webuimodelcontextapi.Path + "/{provider}/{accountRef}/model-context",
		"GET " + webuiwindowactivationapi.Path + "/{provider}/{accountRef}/window-activation",
		"GET " + webuiaccountegressapi.Path + "/{provider}/{accountRef}/egress",
		"POST " + webuiaccountactivityapi.AccountActionPath,
	} {
		mux.Handle(pattern, noop)
	}

	restarter := &stubServerRestarter{}
	routes, err := buildWebUIOpsMiscRoutesWithPorts(
		webuiRouteDependencies{
			Authorizer:  stubOpsAuthorizer{allow: true},
			AIHomeDir:   aiHome,
			HostHomeDir: hostHome,
		},
		webuiOpsMiscPorts{
			Hub:                hub,
			ActivityAccounts:   stubActivityLister{},
			SkipSchedulerStart: true,
			CodexTransport:     stubCodexTransport{},
			ServerRestarter:    restarter,
		},
	)
	if err != nil {
		t.Fatalf("buildWebUIOpsMiscRoutesWithPorts 失败: %v", err)
	}
	if len(routes) != 23 {
		t.Fatalf("期望 23 条路由，实际 %d 条", len(routes))
	}
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// 1. Peer messages
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/peer/messages", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"pm-1"`) {
		t.Fatalf("peer/messages 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 2. Tasks hub (用门闩让任务在断言期间保持 running/queued)
	release := make(chan struct{})
	defer close(release)
	started, errCode := activityJobs.Start(accountactivity.StartRequest{
		Providers:   []string{"zcode"},
		ActionID:    "claim",
		ActionLabel: "领臭鸡蛋",
		Targets:     []accountactivity.Target{{Provider: "zcode", AccountRef: "acct_0123456789abcdef0123"}},
		Execute: func(_ context.Context, _ accountactivity.Target) map[string]any {
			<-release
			return map[string]any{"ok": true}
		},
	})
	if errCode != "" || started.Job.ID == "" {
		t.Fatalf("创建活动作业失败: %s", errCode)
	}
	taskhub.AttachAccountActivityJobs(hub, activityJobs)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/tasks", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), started.Job.ID) {
		t.Fatalf("tasks 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 3. Scheduled tasks list + preview
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/scheduled-tasks", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("scheduled-tasks GET 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/scheduled-tasks/preview", strings.NewReader(`{"schedule":{"kind":"daily","at":"09:30"}}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"at":"09:30"`) {
		t.Fatalf("scheduled-tasks/preview 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 4. Codex reset credits route matching (list)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/accounts/codex/acct_0123456789abcdef0123/reset-credits", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("codex reset-credits GET 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 5. Server restart route matching
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/server/restart", nil))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("server/restart POST 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}
	var restartBody map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &restartBody); err != nil || restartBody["accepted"] != true {
		t.Fatalf("server/restart JSON 异常: %s", rec.Body.String())
	}

	// 6. Account outcomes 返回 200 空状态条视图（有 aiHomeDir 时）
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/account-outcomes", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"dayStarts"`) {
		t.Fatalf("account-outcomes 异常 status=%d body=%s", rec.Code, rec.Body.String())
	}

	// AIHomeDir 与 Store 均缺失时 account-outcomes 回 503，Build 不崩溃
	emptyRoutes, buildEmptyErr := buildWebUIOpsMiscRoutesWithPorts(
		webuiRouteDependencies{Authorizer: stubOpsAuthorizer{allow: true}},
		webuiOpsMiscPorts{SkipSchedulerStart: true},
	)
	if buildEmptyErr != nil {
		t.Fatalf("空目录装配不应失败: %v", buildEmptyErr)
	}
	emptyMux := http.NewServeMux()
	for _, r := range emptyRoutes {
		emptyMux.Handle(r.Pattern, r.Handler)
	}
	rec = httptest.NewRecorder()
	emptyMux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/account-outcomes", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺少 Store 与 AIHomeDir 时应回 503，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	emptyMux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/server/restart", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("缺少 AIHomeDir 且未注入 ServerRestarter 时 server/restart 应回 503，实际 %d body=%s", rec.Code, rec.Body.String())
	}

	// restarter 端口注入路径：默认 NativeRestarter 会真的调用宿主服务管理器，
	// 测试里必须显式注入，禁止 test 运行一次就重启本机 aih 服务。
	wiredRestartRoutes, buildWiredErr := buildWebUIOpsMiscRoutesWithPorts(
		webuiRouteDependencies{
			Authorizer: stubOpsAuthorizer{allow: true},
			AIHomeDir:  t.TempDir(),
		},
		webuiOpsMiscPorts{SkipSchedulerStart: true, ServerRestarter: restarter},
	)
	if buildWiredErr != nil {
		t.Fatalf("默认 NativeRestarter 装配不应失败: %v", buildWiredErr)
	}
	wiredRestartMux := http.NewServeMux()
	for _, r := range wiredRestartRoutes {
		wiredRestartMux.Handle(r.Pattern, r.Handler)
	}
	rec = httptest.NewRecorder()
	wiredRestartMux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/management/webui/server/restart", nil))
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"restarting":true`) {
		t.Fatalf("注入 restarter 端口后应接单回 202，实际 %d body=%s", rec.Code, rec.Body.String())
	}

	// 确认 buildWebUIOpsMiscRoutes 默认导出签名为 nil authorizer 时失败关闭
	if _, buildErr := buildWebUIOpsMiscRoutes(webuiRouteDependencies{}); buildErr == nil {
		t.Fatal("Authorizer 为 nil 时应当报错")
	}
	_ = codexresetcredit.ErrInvalidDependencies
}
