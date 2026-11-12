package webuiaccountliveapi

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeRows struct {
	rows  []webuiaccountsapi.Row
	err   error
	calls int
}

func (fake *fakeRows) ListAccountRows(
	context.Context,
	webuiaccountsapi.Query,
) (webuiaccountsapi.Result, error) {
	fake.calls++
	if fake.err != nil {
		return webuiaccountsapi.Result{}, fake.err
	}
	return webuiaccountsapi.Result{Rows: append([]webuiaccountsapi.Row(nil), fake.rows...)}, nil
}

type fakeRuntime struct {
	views []runtimeapp.AccountView
}

func (fake fakeRuntime) RuntimeSnapshot() []runtimeapp.AccountView { return fake.views }

type fakeStates struct {
	states    []runtimecore.AccountState
	lastError error
}

func (fake fakeStates) ListAccountStates(context.Context) ([]runtimecore.AccountState, error) {
	return fake.states, fake.lastError
}

type fakeTokenUsage struct {
	calls int
	value usageledger.AccountTokenUsage
	err   error
}

func (fake *fakeTokenUsage) QueryAccountTokenUsage(
	context.Context,
	usageledger.Query,
	int,
) (usageledger.AccountTokenUsage, error) {
	fake.calls++
	return fake.value, fake.err
}

func testRef(suffix string) string {
	return "acct_" + strings.Repeat(suffix, 20)
}

func testRow(ref, provider string, enabled bool) webuiaccountsapi.Row {
	return webuiaccountsapi.Row{
		Provider: provider, AccountRef: ref, Enabled: enabled,
		DisplayName: provider + " account", UpdatedAt: 10,
	}
}

func newTestHub(t *testing.T, rows *fakeRows, deps ...any) *Hub {
	t.Helper()
	options := hubOptions{rows: rows, now: time.Now}
	for _, dep := range deps {
		switch typed := dep.(type) {
		case RuntimeSource:
			options.runtime = typed
		case StateSource:
			options.states = typed
		case TokenUsageSource:
			options.tokenUsage = typed
		}
	}
	return newHub(options)
}

func readFrame(t *testing.T, sub *subscriber) map[string]any {
	t.Helper()
	select {
	case frame := <-sub.events:
		payload := strings.TrimSpace(strings.TrimPrefix(string(frame), "data:"))
		var decoded map[string]any
		if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
			t.Fatalf("解析事件失败: %v (%s)", err, payload)
		}
		return decoded
	case <-time.After(2 * time.Second):
		t.Fatal("等待事件超时")
		return nil
	}
}

func TestRefreshBroadcastsAccountAddsChangesAndRemovals(t *testing.T) {
	first := testRef("1")
	second := testRef("2")
	third := testRef("3")
	source := &fakeRows{rows: []webuiaccountsapi.Row{
		testRow(first, "codex", true),
		testRow(second, "claude", true),
	}}
	hub := newTestHub(t, source)
	defer hub.close()

	hub.ensureSnapshot(context.Background())
	sub := hub.subscribe()
	defer hub.unsubscribe(sub)

	changed := testRow(first, "codex", false)
	changed.Status = "down"
	added := testRow(third, "agy", true)
	added.Status = "up"
	hub.applyRows([]webuiaccountsapi.Row{changed, added}, false)

	accounts := map[string]map[string]any{}
	var removed map[string]any
	hydrated := false
	for index := 0; index < 5; index++ {
		frame := readFrame(t, sub)
		switch frame["type"] {
		case "account":
			row := frame["account"].(map[string]any)
			accounts[row["accountRef"].(string)] = row
		case "account-removed":
			removed = frame
		case "hydrated":
			hydrated = true
		}
		if hydrated {
			break
		}
	}
	changedRow, ok := accounts[first]
	if !ok || changedRow["status"] != "down" {
		t.Fatalf("缺少 first 的变化事件: %v", accounts)
	}
	if _, ok := accounts[third]; !ok {
		t.Fatalf("缺少 third 的新增事件: %v", accounts)
	}
	if removed == nil || removed["accountRef"] != second {
		t.Fatalf("缺少 second 的删除事件: %v", removed)
	}
	if !hydrated {
		t.Fatal("缺少 hydrated 事件")
	}
}

func TestEnrichRowsFillsNodeOnlyFields(t *testing.T) {
	ref := testRef("a")
	capturedAt := int64(1000)
	row := testRow(ref, "codex", true)
	row.UsageSnapshot = map[string]any{"capturedAt": float64(capturedAt)}
	source := &fakeRows{rows: []webuiaccountsapi.Row{row}}
	parsedRef, err := accountcore.ParseAccountRef(ref)
	if err != nil {
		t.Fatalf("解析 ref 失败: %v", err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: parsedRef,
		Document:   []byte(`{"lastSuccessAt":1500}`),
		UpdatedAt:  time.Now(),
	})
	if err != nil {
		t.Fatalf("构造运行态失败: %v", err)
	}
	runtimeSource := fakeRuntime{views: []runtimeapp.AccountView{{
		AccountRef:    parsedRef,
		Blocks:        []runtimecore.RecoveryTrigger{"usage_snapshot"},
		LastSuccessAt: time.UnixMilli(2000),
	}}}
	tokens := &fakeTokenUsage{value: usageledger.AccountTokenUsage{
		Day: 7, Total: 7,
		Models: []usageledger.AccountTokenUsageModel{{Model: "gpt-5", Day: 7, Total: 7}},
	}}
	hub := newTestHub(t, source)
	hub.runtime = runtimeSource
	hub.states = fakeStates{states: []runtimecore.AccountState{state}}
	hub.tokenUsage = tokens
	defer hub.close()

	rows, err := hub.loadRows(context.Background())
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("行数不符: %d", len(rows))
	}
	enriched := rows[0]
	if enriched.Status != "up" {
		t.Fatalf("status = %q, want up", enriched.Status)
	}
	if enriched.RuntimeStatus != "rate_limited" || enriched.RuntimeReason != "go_runtime_quota_exhausted" {
		t.Fatalf("运行态未按 Go 阻塞折算: %+v", enriched)
	}
	if enriched.LastUsedAt == nil || *enriched.LastUsedAt != 2000 {
		t.Fatalf("lastUsedAt = %v, want 2000", enriched.LastUsedAt)
	}
	if enriched.TokenUsageSource != "go" || enriched.TokenUsage == nil {
		t.Fatalf("token 用量未填: %+v", enriched)
	}
	usage := enriched.TokenUsage.(*tokenUsageView)
	if usage.Day != 7 || len(usage.Models) != 1 {
		t.Fatalf("token 用量内容不符: %+v", usage)
	}
	// 第二次装配走 60s 缓存，不应再查询账本。
	if _, err := hub.loadRows(context.Background()); err != nil {
		t.Fatalf("第二次装配失败: %v", err)
	}
	if tokens.calls != 1 {
		t.Fatalf("token 用量查询次数 = %d, want 1", tokens.calls)
	}
}

func TestRequestRefreshEmitsSnapshotRequestedAndHydrated(t *testing.T) {
	source := &fakeRows{rows: []webuiaccountsapi.Row{testRow(testRef("b"), "codex", true)}}
	hub := newTestHub(t, source)
	defer hub.close()
	hub.ensureSnapshot(context.Background())
	sub := hub.subscribe()
	defer hub.unsubscribe(sub)

	requestedAt, alreadyRunning := hub.requestRefresh()
	if requestedAt <= 0 || alreadyRunning {
		t.Fatalf("requestRefresh = (%d,%v)", requestedAt, alreadyRunning)
	}
	first := readFrame(t, sub)
	if first["type"] != "snapshot-requested" {
		t.Fatalf("首帧 = %v, want snapshot-requested", first)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frame := readFrame(t, sub)
		if frame["type"] == "hydrated" {
			return
		}
	}
	t.Fatal("强制刷新没有发出 hydrated")
}

func TestWatchStreamSendsConnectedThenSnapshot(t *testing.T) {
	source := &fakeRows{rows: []webuiaccountsapi.Row{testRow(testRef("c"), "codex", true)}}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Rows:       source,
		Heartbeat:  time.Hour,
	})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	defer handler.Close()
	server := httptest.NewServer(handler)
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL+Path, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	request.Header.Set("Authorization", "Bearer key")
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("状态 = %d, want 200", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	first := readSseData(t, reader)
	second := readSseData(t, reader)
	if !strings.Contains(first, "connected") {
		t.Fatalf("首帧 = %q", first)
	}
	if !strings.Contains(second, "\"type\":\"snapshot\"") || !strings.Contains(second, testRef("c")) {
		t.Fatalf("快照帧不完整: %q", second)
	}
}

func readSseData(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("读取事件失败: %v", err)
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(trimmed, "data:") {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		}
	}
}

func TestWatchRequiresAuthorization(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Rows:       &fakeRows{},
	})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	defer handler.Close()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态 = %d, want 401", recorder.Code)
	}
}

func TestSnapshotRequestReturnsAccepted(t *testing.T) {
	source := &fakeRows{rows: []webuiaccountsapi.Row{testRow(testRef("d"), "codex", true)}}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true}, Rows: source, Heartbeat: time.Hour,
	})
	if err != nil {
		t.Fatalf("创建接口失败: %v", err)
	}
	defer handler.Close()
	handler.hub.ensureSnapshot(context.Background())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, SnapshotPath, nil))
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("状态 = %d, want 202", recorder.Code)
	}
	body, _ := io.ReadAll(recorder.Body)
	if !strings.Contains(string(body), `"accepted":true`) {
		t.Fatalf("响应体 = %s", body)
	}
}
