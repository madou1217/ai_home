package aihserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectswriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacefsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacegitapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiworkspacemodelsapi"
)

type projectsFSRoutesTestAuthorizer struct{}

func (projectsFSRoutesTestAuthorizer) Authorized(*http.Request) bool { return true }

func TestBuildWebUIProjectsFSRoutes(t *testing.T) {
	t.Run("返回全部十二条预期路由并与现有 webuiRoutes 无模式冲突", func(t *testing.T) {
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

		deps := webuiRouteDependencies{
			Authorizer:  projectsFSRoutesTestAuthorizer{},
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
			Catalog:     catalog,
			Store:       store,
		}
		routes, err := buildWebUIProjectsFSRoutes(deps)
		if err != nil {
			t.Fatalf("buildWebUIProjectsFSRoutes() error = %v", err)
		}
		want := []string{
			"POST " + webuiprojectswriteapi.BrowsePath,
			"POST " + webuiprojectswriteapi.OpenPath,
			"POST " + webuiprojectswriteapi.RemovePath,
			"POST " + webuiprojectswriteapi.PickPath,
			"GET " + webuiworkspacefsapi.AccessPath,
			"GET " + webuiworkspacefsapi.ReadPath,
			"GET " + webuiworkspacefsapi.TreePath,
			"GET " + webuiworkspacefsapi.MediaPath,
			"POST " + webuiworkspacefsapi.TrustPath,
			"GET " + webuiworkspacegitapi.SummaryPath,
			"GET " + webuiworkspacegitapi.DiffPath,
			"GET " + webuiworkspacemodelsapi.Path,
		}
		if len(routes) != len(want) {
			t.Fatalf("路由数量 = %d, want %d", len(routes), len(want))
		}

		projectsRead, err := webuiprojectsapi.NewHandler(webuiprojectsapi.Dependencies{
			Authorizer:  deps.Authorizer,
			HostHomeDir: deps.HostHomeDir,
			AiHomeDir:   deps.AIHomeDir,
		})
		if err != nil {
			t.Fatalf("webuiprojectsapi.NewHandler() error = %v", err)
		}
		mux := http.NewServeMux()
		mux.Handle("GET "+webuiprojectsapi.Path, projectsRead)
		mux.Handle("GET "+webuiprojectsapi.SessionsPath, projectsRead)
		mux.Handle("GET "+webuiprojectsapi.WatchPath, projectsRead)
		mux.Handle("POST "+webuiprojectsapi.SnapshotPath, projectsRead)
		for i, pattern := range want {
			if routes[i].Pattern != pattern {
				t.Fatalf("routes[%d].Pattern = %q, want %q", i, routes[i].Pattern, pattern)
			}
			if routes[i].Handler == nil {
				t.Fatalf("routes[%d].Handler 为空: %q", i, pattern)
			}
			mux.Handle(routes[i].Pattern, routes[i].Handler)
		}

		// 验证开箱可用：open 宿主 HOME 之外的手动项目，再用 workspace/fs/tree 和 workspace/models 读取。
		externalProj := filepath.Join(t.TempDir(), "manual-proj")
		if err := os.MkdirAll(externalProj, 0o755); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(filepath.Join(externalProj, "README.md"), []byte("hello"), 0o644); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		openBody, _ := json.Marshal(map[string]string{"projectPath": externalProj})
		openReq := httptest.NewRequest(http.MethodPost, webuiprojectswriteapi.OpenPath, bytes.NewReader(openBody))
		openRes := httptest.NewRecorder()
		mux.ServeHTTP(openRes, openReq)
		if openRes.Code != http.StatusOK {
			t.Fatalf("POST open status = %d, body = %s", openRes.Code, openRes.Body.String())
		}

		treeReq := httptest.NewRequest(http.MethodGet, webuiworkspacefsapi.TreePath+"?projectPath="+url.QueryEscape(externalProj), nil)
		treeRes := httptest.NewRecorder()
		mux.ServeHTTP(treeRes, treeReq)
		if treeRes.Code != http.StatusOK {
			t.Fatalf("GET tree status = %d, body = %s", treeRes.Code, treeRes.Body.String())
		}

		projectsReq := httptest.NewRequest(http.MethodGet, webuiprojectsapi.Path, nil)
		projectsRes := httptest.NewRecorder()
		mux.ServeHTTP(projectsRes, projectsReq)
		if projectsRes.Code != http.StatusOK || !bytes.Contains(projectsRes.Body.Bytes(), []byte("manual-proj")) {
			t.Fatalf("GET projects status = %d, body = %s", projectsRes.Code, projectsRes.Body.String())
		}

		modelsReq := httptest.NewRequest(http.MethodGet, webuiworkspacemodelsapi.Path, nil)
		modelsRes := httptest.NewRecorder()
		mux.ServeHTTP(modelsRes, modelsReq)
		if modelsRes.Code != http.StatusOK {
			t.Fatalf("GET workspace models status = %d, body = %s", modelsRes.Code, modelsRes.Body.String())
		}
	})

	t.Run("Store 为空时仍保留前十一条项目与工作区文件 Git 路由", func(t *testing.T) {
		routes, err := buildWebUIProjectsFSRoutes(webuiRouteDependencies{
			Authorizer:  projectsFSRoutesTestAuthorizer{},
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
		})
		if err != nil {
			t.Fatalf("buildWebUIProjectsFSRoutes() error = %v", err)
		}
		if len(routes) != 11 {
			t.Fatalf("路由数量 = %d, want 11", len(routes))
		}
	})

	t.Run("缺少鉴权器时拒绝装配", func(t *testing.T) {
		if _, err := buildWebUIProjectsFSRoutes(webuiRouteDependencies{
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
		}); err == nil {
			t.Fatal("缺少 Authorizer 时应当返回错误")
		}
	})
}
