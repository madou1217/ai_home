package aihserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/webuiauth"
	"github.com/madou1217/ai_home/internal/transport/http/webuirestoreschedulingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionhookapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionslifecycleapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisessionwatchapi"
)

const codexAppServerPassthroughEnv = "AIH_CODEX_APP_SERVER_PASSTHROUGH"

type hookSessionActivityTracker struct {
	activity *sessionactivity.AccountActivity
}

func (tracker hookSessionActivityTracker) MarkSessionTurn(provider, accountRef string) {
	if tracker.activity != nil {
		tracker.activity.MarkSessionTurn(provider, accountRef, 0)
	}
}

func (tracker hookSessionActivityTracker) EndSessionTurn(provider, accountRef string) {
	if tracker.activity != nil {
		tracker.activity.EndSessionTurn(provider, accountRef)
	}
}

func (tracker hookSessionActivityTracker) SelectionLoad(provider, accountRef, model string) sessionactivity.SelectionLoad {
	if tracker.activity != nil {
		return tracker.activity.SelectionLoad(provider, accountRef, model)
	}
	return sessionactivity.SelectionLoad{
		WindowMS: sessionactivity.DefaultRateWindow.Milliseconds(),
	}
}

// buildWebUISessionsWatchRoutes 装配会话实时监听、Provider Hook 事件接收与恢复归档路由。
//
// watch 与 provider-hook 共用同一个 Go sessionevents.Bus 与持久化 StateStore，
// unarchive 通过独立的 Codex app-server 宿主环境拨号承接原生恢复，彻底脱离 Node 进程状态。
func buildWebUISessionsWatchRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	bus := dependencies.SessionEventBus
	if bus == nil {
		bus = sessionevents.NewBus(sessionevents.BusOptions{
			AIHomeDir:   dependencies.AIHomeDir,
			HostHomeDir: dependencies.HostHomeDir,
		})
	}
	stateStore := sessionevents.NewStateStore(sessionevents.StateStoreOptions{
		AIHomeDir: dependencies.AIHomeDir,
	})

	sideEffects := newHookAccountSideEffects(dependencies.Store, dependencies.AccountRuntime)

	watchHandler, err := webuisessionwatchapi.NewHandler(webuisessionwatchapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		Bus:         bus,
		AIHomeDir:   dependencies.AIHomeDir,
		HostHomeDir: dependencies.HostHomeDir,
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话监听接口失败: %w", err)
	}

	hookHandler, err := webuisessionhookapi.NewHandler(webuisessionhookapi.Dependencies{
		Authorizer:       dependencies.Authorizer,
		Bus:              bus,
		StateStore:       stateStore,
		Catalog:          dependencies.Catalog,
		AIHomeDir:        dependencies.AIHomeDir,
		AccountActivity:  dependencies.AccountActivity,
		OutcomeRecorder:  sideEffects,
		RuntimeRecoverer: sideEffects,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Provider Hook 接收接口失败: %w", err)
	}

	unarchiveHandler, err := webuisessionslifecycleapi.NewHandler(webuisessionslifecycleapi.Dependencies{
		Authorizer:  dependencies.Authorizer,
		HostHomeDir: dependencies.HostHomeDir,
		AIHomeDir:   dependencies.AIHomeDir,
		Codex:       buildCodexLifecycleDialer(dependencies.HostHomeDir),
	})
	if err != nil {
		return nil, fmt.Errorf("创建会话恢复归档接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuisessionwatchapi.Path, Handler: watchHandler},
		{Pattern: "POST " + webuisessionhookapi.Path, Handler: hookHandler},
		// 插件回调的公开入口：Node 的 /v0 门只对回环放行，这里用同一判定后注入 Bearer。
		{Pattern: "POST /v0/webui/session-events/provider-hook", Handler: webuiauth.RequireManagementKey(dependencies.ManagementKey, hookHandler)},
		// 远程工具 HTTP 入口：Go 版 agent 终端用直连模式（MCP server 自建 SSH），
		// 这里不再签发令牌；无令牌一律拒绝，避免 Node 桥继续承接该路由。
		{Pattern: "POST /v0/webui/internal/remote-tools", Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json; charset=utf-8")
			response.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"isError": true,
				"content": []any{map[string]any{"type": "text", "text": "[remote_tools_forbidden] 远程工具令牌无效或已过期"}},
			})
		})},
		{Pattern: "POST " + webuisessionslifecycleapi.UnarchivePath, Handler: unarchiveHandler},
	}, nil
}

type hookAccountSideEffects struct {
	store    *sqliteaccount.Store
	restorer webuirestoreschedulingapi.RuntimeRestorer
}

func newHookAccountSideEffects(store *sqliteaccount.Store, runtime any) *hookAccountSideEffects {
	restorer, _ := runtime.(webuirestoreschedulingapi.RuntimeRestorer)
	return &hookAccountSideEffects{
		store:    store,
		restorer: restorer,
	}
}

func (effects *hookAccountSideEffects) RecordHookOutcome(
	ctx context.Context,
	provider string,
	accountRef string,
	outcome string,
	at time.Time,
) {
	if effects == nil || effects.store == nil || strings.TrimSpace(outcome) == "" {
		return
	}
	ref, ok := effects.verifiedProviderAccount(ctx, provider, accountRef)
	if !ok {
		return
	}
	if at.IsZero() {
		at = time.Now()
	}
	deltas := []accountoutcomes.Delta{
		{
			AccountRef:    ref,
			Granularity:   accountoutcomes.Hour,
			BucketStartMS: accountoutcomes.BucketStart(at, accountoutcomes.Hour, time.Local),
			Outcome:       outcome,
			Count:         1,
		},
		{
			AccountRef:    ref,
			Granularity:   accountoutcomes.Day,
			BucketStartMS: accountoutcomes.BucketStart(at, accountoutcomes.Day, time.Local),
			Outcome:       outcome,
			Count:         1,
		},
	}
	_ = effects.store.AddAccountOutcomes(ctx, deltas)
}

func (effects *hookAccountSideEffects) RecoverOnHookSuccess(
	ctx context.Context,
	provider string,
	accountRef string,
	happenedAtMs int64,
) bool {
	if effects == nil || effects.store == nil || effects.restorer == nil {
		return false
	}
	ref, ok := effects.verifiedProviderAccount(ctx, provider, accountRef)
	if !ok {
		return false
	}
	state, err := effects.store.GetAccountState(ctx, ref)
	if err != nil {
		return false
	}
	block, hasBlock := state.DeriveBlock()
	if !hasBlock {
		return false
	}
	if happenedAtMs > 0 && block.ObservedAt().UnixMilli() > happenedAtMs {
		return false
	}
	if !block.Until().After(time.Now()) {
		return false
	}
	return effects.restorer.RestoreScheduling(ctx, ref) == nil
}

func (effects *hookAccountSideEffects) verifiedProviderAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (accountcore.AccountRef, bool) {
	ref, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil || !ref.IsValid() {
		return "", false
	}
	overview, err := effects.store.GetAccountOverview(ctx, ref)
	if err != nil {
		return "", false
	}
	expected := strings.ToLower(strings.TrimSpace(provider))
	actual := strings.ToLower(strings.TrimSpace(overview.Account().ProviderID()))
	if expected == "" || actual != expected {
		return "", false
	}
	return ref, true
}

func buildCodexLifecycleDialer(hostHomeDir string) webuisessionslifecycleapi.CodexDialer {
	cleanHome := strings.TrimSpace(hostHomeDir)
	if cleanHome == "" {
		return nil
	}
	return func(ctx context.Context) (webuisessionslifecycleapi.CodexClient, error) {
		executablePath, err := providercli.ResolveBinary("codex", "codex")
		if err != nil {
			return nil, err
		}
		codexHome := filepath.Join(cleanHome, ".codex")
		if mkErr := os.MkdirAll(codexHome, 0o755); mkErr != nil {
			return nil, mkErr
		}
		client, err := appserver.Dial(ctx, appserver.Config{
			Command: executablePath,
			Args:    []string{"app-server", "--listen", "stdio://"},
			Dir:     cleanHome,
			Env:     buildCodexHostLifecycleEnv(cleanHome, codexHome),
			ClientInfo: appserver.ClientInfo{
				Name:    "aih-session-lifecycle",
				Title:   "AIH Session Lifecycle",
				Version: "1.0.0",
			},
		})
		if err != nil {
			return nil, err
		}
		return client, nil
	}
}

func buildCodexHostLifecycleEnv(hostHomeDir, codexHome string) []string {
	overrides := map[string]string{
		"HOME":                       hostHomeDir,
		"USERPROFILE":                hostHomeDir,
		"CODEX_HOME":                 codexHome,
		"CODEX_SQLITE_HOME":          codexHome,
		"XDG_CONFIG_HOME":            hostHomeDir,
		"XDG_DATA_HOME":              filepath.Join(hostHomeDir, ".local", "share"),
		"XDG_STATE_HOME":             filepath.Join(hostHomeDir, ".local", "state"),
		codexAppServerPassthroughEnv: "1",
	}
	base := os.Environ()
	out := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, overridden := overrides[name]; overridden {
				continue
			}
		}
		out = append(out, entry)
	}
	for key, val := range overrides {
		out = append(out, key+"="+val)
	}
	return out
}
