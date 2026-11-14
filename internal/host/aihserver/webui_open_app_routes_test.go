package aihserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

type openAppStubAuth bool

func (a openAppStubAuth) Authorized(*http.Request) bool { return bool(a) }

func TestBuildWebUIOpenAppRoutesAndNativeLauncher(t *testing.T) {
	t.Parallel()

	// Authorizer 或 Store 缺失时安全跳过装配，不报错也不注册空路由。
	routes, err := buildWebUIOpenAppRoutes(webuiRouteDependencies{})
	if err != nil || len(routes) != 0 {
		t.Fatalf("expected empty routes when deps missing, got routes=%v err=%v", routes, err)
	}

	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() { _ = store.Close() }()

	termHandler := &webuiterminalapi.Handler{}
	deps := webuiRouteDependencies{
		Authorizer:      openAppStubAuth(true),
		AIHomeDir:       aiHomeDir,
		HostHomeDir:     hostHomeDir,
		Catalog:         catalog,
		Store:           store,
		TerminalHandler: termHandler,
	}

	launcher := newWebUIOpenAppLauncher(deps)
	if _, ok := launcher.(*webuiopenappapi.NativeLauncher); !ok {
		t.Fatalf("expected *webuiopenappapi.NativeLauncher, got %T", launcher)
	}

	// 验证未初始化 Terminal sessions 时，通过 NativeLauncher 调用 webui 终端能安全转化 LaunchError 而不是 typed-nil panic。
	res, err := launcher.Launch(context.Background(), webuiopenappapi.Request{
		Provider:   "claude",
		Kind:       "cli",
		Action:     "open",
		Harness:    "claude",
		BinaryName: "claude",
		Transport:  "webui",
		SessionKey: "aih-term::claude",
		Executable: "/bin/sh",
	})
	if err != nil {
		t.Fatalf("launcher.Launch() unexpected error: %v", err)
	}
	if res.OK || res.Error != "web_terminal_open_failed" {
		t.Fatalf("expected web_terminal_open_failed when terminal sessions nil, got %+v", res)
	}

	routes, err = buildWebUIOpenAppRoutes(deps)
	if err != nil {
		t.Fatalf("buildWebUIOpenAppRoutes() error = %v", err)
	}
	if len(routes) != 1 || routes[0].Pattern != "POST "+webuiopenappapi.Path+webuiopenappapi.OpenAppSuffix {
		t.Fatalf("unexpected open-app routes: %+v", routes)
	}

	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}
	req := httptest.NewRequest(
		http.MethodPost,
		webuiopenappapi.Path+"/codex/acct_00000000000000000001/open-app",
		strings.NewReader(`{"kind":"cli","transport":"native"}`),
	)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 account_not_found for unknown account, got %d body=%s", rec.Code, rec.Body.String())
	}
}
