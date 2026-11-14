package aihserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionhookapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionslifecycleapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionwatchapi"
)

type sessionsWatchTestAuthorizer struct{}

func (sessionsWatchTestAuthorizer) Authorized(*http.Request) bool { return true }

type sessionsWatchTestRestorer struct {
	restored []accountcore.AccountRef
}

func (r *sessionsWatchTestRestorer) RestoreScheduling(_ context.Context, accountRef accountcore.AccountRef) error {
	r.restored = append(r.restored, accountRef)
	return nil
}

func TestBuildWebUISessionsWatchRoutes(t *testing.T) {
	t.Run("返回五条预期路由且模式完整对齐", func(t *testing.T) {
		routes, err := buildWebUISessionsWatchRoutes(webuiRouteDependencies{
			Authorizer:  sessionsWatchTestAuthorizer{},
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
		})
		if err != nil {
			t.Fatalf("buildWebUISessionsWatchRoutes() error = %v", err)
		}
		want := []string{
			"GET " + webuisessionwatchapi.Path,
			"POST " + webuisessionhookapi.Path,
			"POST /v0/webui/session-events/provider-hook",
			"POST /v0/webui/internal/remote-tools",
			"POST " + webuisessionslifecycleapi.UnarchivePath,
		}
		if len(routes) != len(want) {
			t.Fatalf("路由数量 = %d, want %d: %+v", len(routes), len(want), routes)
		}
		for i, pattern := range want {
			if routes[i].Pattern != pattern {
				t.Fatalf("routes[%d].Pattern = %q, want %q", i, routes[i].Pattern, pattern)
			}
			if routes[i].Handler == nil {
				t.Fatalf("routes[%d].Handler 为空: %q", i, pattern)
			}
		}
	})

	t.Run("缺少鉴权器时拒绝装配", func(t *testing.T) {
		if _, err := buildWebUISessionsWatchRoutes(webuiRouteDependencies{
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
		}); err == nil {
			t.Fatal("缺少 Authorizer 时应当返回错误")
		}
	})

	t.Run("watch SSE 实时收到 hook 事件且 unarchive 恢复归档文件", func(t *testing.T) {
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

		cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
			APIKey:  "sk-watch-route-test",
			BaseURL: "https://api.example/v1",
		})
		if err != nil {
			t.Fatalf("NewAPIKeyAuth() error = %v", err)
		}
		registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time {
			return time.UnixMilli(1_000).UTC()
		})
		if err != nil {
			t.Fatalf("NewRegistrar() error = %v", err)
		}
		account, err := registrar.Register(context.Background(), cred, nil)
		if err != nil {
			t.Fatalf("Register() error = %v", err)
		}
		now := time.Now().UTC()
		blockedState, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
			AccountRef: account.Ref(),
			Document: []byte(`{"rateLimitUntil":` + strings.TrimSpace(jsonNumber(now.Add(2*time.Minute).UnixMilli())) +
				`,"lastFailureKind":"rate_limited","lastFailureAt":` +
				strings.TrimSpace(jsonNumber(now.Add(-time.Second).UnixMilli())) + `}`),
			UpdatedAt: now,
		})
		if err != nil {
			t.Fatalf("NewAccountState() error = %v", err)
		}
		if err := store.ReplaceAccountState(context.Background(), blockedState, nil); err != nil {
			t.Fatalf("ReplaceAccountState() error = %v", err)
		}

		restorer := &sessionsWatchTestRestorer{}
		routes, err := buildWebUISessionsWatchRoutes(webuiRouteDependencies{
			Authorizer:     sessionsWatchTestAuthorizer{},
			AIHomeDir:      aiHomeDir,
			HostHomeDir:    hostHomeDir,
			Catalog:        catalog,
			Store:          store,
			AccountRuntime: restorer,
		})
		if err != nil {
			t.Fatalf("buildWebUISessionsWatchRoutes() error = %v", err)
		}

		mux := http.NewServeMux()
		for _, route := range routes {
			mux.Handle(route.Pattern, route.Handler)
		}
		server := httptest.NewServer(mux)
		defer server.Close()

		watchCtx, cancelWatch := context.WithCancel(context.Background())
		defer cancelWatch()
		watchReq, err := http.NewRequestWithContext(
			watchCtx,
			http.MethodGet,
			server.URL+webuisessionwatchapi.Path+"?provider=codex&sessionId=thread-e2e-1",
			nil,
		)
		if err != nil {
			t.Fatalf("NewRequest() error = %v", err)
		}
		watchResp, err := http.DefaultClient.Do(watchReq)
		if err != nil {
			t.Fatalf("watch GET error = %v", err)
		}
		defer func() { _ = watchResp.Body.Close() }()

		lineCh := make(chan string, 8)
		go func() {
			scanner := bufio.NewScanner(watchResp.Body)
			for scanner.Scan() {
				text := scanner.Text()
				if strings.HasPrefix(text, "data: ") {
					lineCh <- strings.TrimPrefix(text, "data: ")
				}
			}
		}()

		select {
		case first := <-lineCh:
			if !strings.Contains(first, `"type":"connected"`) {
				t.Fatalf("首帧应为 connected, got %s", first)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("等待 watch connected 超时")
		}

		hookBody, _ := json.Marshal(map[string]any{
			"provider":   "codex",
			"eventName":  "Stop",
			"sessionId":  "thread-e2e-1",
			"accountRef": string(account.Ref()),
			"timestamp":  now.UnixMilli(),
		})
		hookResp, err := http.Post(server.URL+webuisessionhookapi.Path, "application/json", bytes.NewReader(hookBody))
		if err != nil {
			t.Fatalf("hook POST error = %v", err)
		}
		defer func() { _ = hookResp.Body.Close() }()
		if hookResp.StatusCode != http.StatusOK {
			t.Fatalf("hook status = %d, want 200", hookResp.StatusCode)
		}
		var hookResult map[string]any
		if err := json.NewDecoder(hookResp.Body).Decode(&hookResult); err != nil {
			t.Fatalf("decode hook response error = %v", err)
		}
		if hookResult["runtimeRecovered"] != true {
			t.Fatalf("hookResult.runtimeRecovered = %v, want true (restored=%v)", hookResult["runtimeRecovered"], restorer.restored)
		}
		if len(restorer.restored) != 1 || restorer.restored[0] != account.Ref() {
			t.Fatalf("RestoreScheduling 调用记录 = %v, want [%s]", restorer.restored, account.Ref())
		}

		select {
		case update := <-lineCh:
			if !strings.Contains(update, `"type":"update"`) || !strings.Contains(update, `"sessionId":"thread-e2e-1"`) {
				t.Fatalf("watch 收到异常更新帧: %s", update)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("等待 watch 更新帧超时")
		}

		buckets, err := store.ListAccountOutcomes(context.Background(), accountoutcomes.Hour, 0)
		if err != nil {
			t.Fatalf("ListAccountOutcomes() error = %v", err)
		}
		if len(buckets) == 0 || buckets[0].Outcome != accountoutcomes.OutcomeSuccess {
			t.Fatalf("未记录成功结果桶: %+v", buckets)
		}

		// 验证通过路由装配出的 /unarchive 可以恢复 Claude 归档文件。
		archivedDir := filepath.Join(hostHomeDir, ".claude", "projects", "proj-a", ".archived")
		if err := os.MkdirAll(archivedDir, 0o755); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		archivedFile := filepath.Join(archivedDir, "sess-restore-1.jsonl")
		if err := os.WriteFile(archivedFile, []byte("{\"ok\":true}\n"), 0o644); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		unarchiveBody := []byte(`{"provider":"claude","sessionId":"sess-restore-1"}`)
		unarchiveResp, err := http.Post(
			server.URL+webuisessionslifecycleapi.UnarchivePath,
			"application/json",
			bytes.NewReader(unarchiveBody),
		)
		if err != nil {
			t.Fatalf("unarchive POST error = %v", err)
		}
		defer func() { _ = unarchiveResp.Body.Close() }()
		if unarchiveResp.StatusCode != http.StatusOK {
			t.Fatalf("unarchive status = %d, want 200", unarchiveResp.StatusCode)
		}
		restoredFile := filepath.Join(hostHomeDir, ".claude", "projects", "proj-a", "sess-restore-1.jsonl")
		if _, statErr := os.Stat(restoredFile); statErr != nil {
			t.Fatalf("恢复后的文件不存在: %v", statErr)
		}
	})
}

func jsonNumber(v int64) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
