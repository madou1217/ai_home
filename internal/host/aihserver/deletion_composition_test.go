package aihserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const (
	compositionDeletionChildEnv = "AIH_TEST_COMPOSITION_DELETION_CHILD"
	compositionFakeTmuxModeEnv  = "AIH_TEST_FAKE_TMUX_MODE"
	compositionTargetModel      = "gpt-composition-delete-target"
	compositionOtherModel       = "gpt-composition-delete-other"
)

// TestProductionCompositionInterlocksAccountDeletion 把 Node 已确认的
// live-writer/stale registry 边界接到生产 Composition：只有精确会话可证明退出，
// 才能继续清理旧 projection 并提交 SQLite 删除。
func TestProductionCompositionInterlocksAccountDeletion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("当前宿主只验收 tmux；Windows psmux 需要 Windows 实机验收")
	}
	if scenario := os.Getenv(compositionDeletionChildEnv); scenario != "" {
		runCompositionDeletionChild(t, scenario)
		return
	}

	tests := []struct {
		name       string
		mode       string
		withEngine bool
	}{
		{name: "live exact session", mode: "live", withEngine: true},
		{name: "verified stale session", mode: "stale", withEngine: true},
		{name: "tmux missing", mode: "missing", withEngine: false},
		{name: "tmux abnormal exit", mode: "abnormal", withEngine: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			runCompositionDeletionSubprocess(
				t,
				test.mode,
				test.withEngine,
			)
		})
	}
}

// runCompositionDeletionSubprocess 给单独测试进程设置唯一 PATH，避免修改
// 当前 go test 进程的全局环境，也保证生产 Guard 不会调用系统真实 tmux。
func runCompositionDeletionSubprocess(
	t *testing.T,
	mode string,
	withEngine bool,
) {
	t.Helper()

	engineDir := t.TempDir()
	if withEngine {
		writeFakeTmux(t, engineDir)
	}
	testExecutable, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable() error = %v", err)
	}
	command := exec.Command(
		testExecutable,
		"-test.run=^TestProductionCompositionInterlocksAccountDeletion$",
		"-test.v",
	)
	command.Env = compositionDeletionChildEnvironment(engineDir, mode)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("隔离 Composition 删除场景 %s 失败: %v\n%s", mode, err, output)
	}
}

// compositionDeletionChildEnvironment 只替换子进程的 PATH 和场景标识。
func compositionDeletionChildEnvironment(engineDir string, mode string) []string {
	environment := make([]string, 0, len(os.Environ())+3)
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if name == "PATH" ||
			name == compositionDeletionChildEnv ||
			name == compositionFakeTmuxModeEnv {
			continue
		}
		environment = append(environment, value)
	}
	return append(
		environment,
		"PATH="+engineDir,
		compositionDeletionChildEnv+"="+mode,
		compositionFakeTmuxModeEnv+"="+mode,
	)
}

// writeFakeTmux 创建只使用 shell builtin 的临时探针，绝不委托系统 tmux。
func writeFakeTmux(t *testing.T, directory string) {
	t.Helper()

	const script = `#!/bin/sh
case "${AIH_TEST_FAKE_TMUX_MODE}" in
  live)
    printf 'p-node-live\n'
    exit 0
    ;;
  stale)
    printf 'p-unrelated\n'
    exit 0
    ;;
  abnormal)
    printf 'synthetic tmux probe failure\n' >&2
    exit 2
    ;;
  *)
    exit 99
    ;;
esac
`
	path := filepath.Join(directory, "tmux")
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatalf("os.WriteFile(fake tmux) error = %v", err)
	}
}

// runCompositionDeletionChild 在临时 AIH_HOME 上装配真实 Handler、SQLite、
// 模型刷新 worker 和 TCP Listener，并执行一个删除互锁场景。
func runCompositionDeletionChild(t *testing.T, scenario string) {
	t.Helper()

	aiHomeDir := t.TempDir()
	discoverer := newCompositionDeletionDiscoverer()
	discoverers := accountmodels.NewDiscoverers()
	discoverers[0] = discoverer
	baseURL, client := startCompositionDeletionServer(
		t,
		aiHomeDir,
		discoverers,
	)

	targetRef := registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"codex",
		discoverer.targetInitialKey,
	)
	otherRef := registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"codex",
		discoverer.otherKey,
	)
	waitForAccountModels(
		t,
		client,
		baseURL,
		targetRef,
		[]string{compositionTargetModel},
	)
	waitForAccountModels(
		t,
		client,
		baseURL,
		otherRef,
		[]string{compositionOtherModel},
	)
	setCompositionDefault(t, client, baseURL, targetRef)
	rotateCompositionTargetCredential(
		t,
		client,
		baseURL,
		targetRef,
		discoverer.targetRotatedKey,
	)
	awaitSignal(t, discoverer.targetRefreshStarted, "等待目标账号 pending 模型刷新")
	seedCompositionUsage(t, aiHomeDir, targetRef)
	assertCompositionAccountSurfaces(
		t,
		client,
		baseURL,
		targetRef,
		compositionTargetModel,
	)

	projectionRoot := writeCompositionProjection(
		t,
		aiHomeDir,
		targetRef,
		discoverer.targetRotatedKey,
	)
	registryPath := writeCompositionRegistry(
		t,
		aiHomeDir,
		targetRef,
		"p-node-live",
	)
	deleted := performRequest(
		t,
		client,
		http.MethodDelete,
		baseURL+accountsapi.CollectionPath+"/"+targetRef,
		testManagementKey,
		nil,
	)

	switch scenario {
	case "stale":
		assertStatus(t, deleted, http.StatusNoContent)
		assertPathMissing(t, registryPath, "verified stale registry")
		assertPathMissing(t, projectionRoot, "Node auth projection")
		awaitSignal(t, discoverer.targetRefreshCanceled, "等待删除取消 pending 模型刷新")
		assertCompositionTargetDeleted(t, client, baseURL, aiHomeDir, targetRef)
	case "live":
		assertStatus(t, deleted, http.StatusConflict)
		assertJSONErrorCode(t, deleted.body, "account_runtime_active")
		assertCompositionDeletionRejected(
			t,
			client,
			baseURL,
			aiHomeDir,
			targetRef,
			registryPath,
			projectionRoot,
		)
		assertSignalPending(
			t,
			discoverer.targetRefreshCanceled,
			"活跃会话拒绝后 pending 模型刷新被误取消",
		)
	case "missing", "abnormal":
		assertStatus(t, deleted, http.StatusServiceUnavailable)
		assertJSONErrorCode(t, deleted.body, "account_runtime_unverifiable")
		assertCompositionDeletionRejected(
			t,
			client,
			baseURL,
			aiHomeDir,
			targetRef,
			registryPath,
			projectionRoot,
		)
		assertSignalPending(
			t,
			discoverer.targetRefreshCanceled,
			"运行时不可确认后 pending 模型刷新被误取消",
		)
	default:
		t.Fatalf("未知 Composition 删除场景 %q", scenario)
	}
	assertCompositionOtherAccountUnaffected(t, client, baseURL, otherRef)
}

// compositionDeletionDiscoverer 先物化两个账号的独立模型，再让目标账号
// 凭据轮换后的刷新保持 pending，供删除清理验证取消代次。
type compositionDeletionDiscoverer struct {
	targetInitialKey      string
	targetRotatedKey      string
	otherKey              string
	targetRefreshStarted  chan struct{}
	targetRefreshCanceled chan struct{}
	startedOnce           sync.Once
	canceledOnce          sync.Once
}

func newCompositionDeletionDiscoverer() *compositionDeletionDiscoverer {
	return &compositionDeletionDiscoverer{
		targetInitialKey:      "synthetic-composition-delete-target-initial-key",
		targetRotatedKey:      "synthetic-composition-delete-target-rotated-key",
		otherKey:              "synthetic-composition-delete-other-key",
		targetRefreshStarted:  make(chan struct{}),
		targetRefreshCanceled: make(chan struct{}),
	}
}

func (*compositionDeletionDiscoverer) ProviderID() string {
	return "codex"
}

func (discoverer *compositionDeletionDiscoverer) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	apiKeyCredential, ok := credential.(interface{ APIKey() string })
	if !ok {
		return nil, errors.New("synthetic discoverer 只接受 API Key")
	}
	switch apiKeyCredential.APIKey() {
	case discoverer.targetInitialKey:
		return []string{compositionTargetModel}, nil
	case discoverer.otherKey:
		return []string{compositionOtherModel}, nil
	case discoverer.targetRotatedKey:
		discoverer.startedOnce.Do(func() {
			close(discoverer.targetRefreshStarted)
		})
		<-ctx.Done()
		discoverer.canceledOnce.Do(func() {
			close(discoverer.targetRefreshCanceled)
		})
		return nil, ctx.Err()
	default:
		return nil, errors.New("synthetic discoverer 收到未知 API Key")
	}
}

// startCompositionDeletionServer 使用显式临时 AIH_HOME 启动独立随机端口。
func startCompositionDeletionServer(
	t *testing.T,
	aiHomeDir string,
	discoverers []accountapp.ProviderModelDiscoverer,
) (string, *http.Client) {
	t.Helper()

	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:        aiHomeDir,
		ManagementKey:    func() string { return testManagementKey },
		ClientKey:        func() string { return testClientKey },
		ModelDiscoverers: discoverers,
		UsageHTTPClient:  syntheticUsageHTTPClient{},
	})
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: 3 * time.Second,
	}
}

func setCompositionDefault(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
) {
	t.Helper()

	payload, err := json.Marshal(map[string]string{"account_ref": accountRef})
	if err != nil {
		t.Fatalf("json.Marshal(default) error = %v", err)
	}
	exchange := performRequest(
		t,
		client,
		http.MethodPut,
		baseURL+accountsapi.DefaultsPath+"/codex",
		testManagementKey,
		payload,
	)
	assertStatus(t, exchange, http.StatusOK)
}

func rotateCompositionTargetCredential(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
	apiKey string,
) {
	t.Helper()

	payload, err := json.Marshal(map[string]any{
		"auth": map[string]string{
			"kind":    "api_key",
			"api_key": apiKey,
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(rotation) error = %v", err)
	}
	exchange := performRequest(
		t,
		client,
		http.MethodPut,
		baseURL+accountsapi.CollectionPath+"/"+accountRef+"/credential",
		testManagementKey,
		payload,
	)
	assertStatus(t, exchange, http.StatusOK)
}

// seedCompositionUsage 通过同一 SQLite adapter 写入低敏额度快照，确保删除
// 验收覆盖 usage 从属数据，而不是只检查 accounts 主记录。
func seedCompositionUsage(t *testing.T, aiHomeDir string, rawRef string) {
	t.Helper()

	accountRef := parseCompositionAccountRef(t, rawRef)
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "composition_test",
		CapturedAt: time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC),
		Entries: []usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 7_500,
			Availability:         usagecore.AvailabilityAvailable,
		}},
	})
	if err != nil {
		t.Fatalf("accountusage.NewSnapshot() error = %v", err)
	}
	withCompositionStore(t, aiHomeDir, func(store *sqliteaccount.Store) {
		if err := store.ReplaceUsageSnapshot(
			context.Background(),
			snapshot,
		); err != nil {
			t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
		}
	})
}

func writeCompositionProjection(
	t *testing.T,
	aiHomeDir string,
	accountRef string,
	apiKey string,
) string {
	t.Helper()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: apiKey})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	document, err := authfile.Encode(credential)
	if err != nil {
		t.Fatalf("authfile.Encode() error = %v", err)
	}
	projectionRoot := filepath.Join(
		aiHomeDir,
		"run",
		"auth-projections",
		"codex",
		accountRef,
	)
	authPath := filepath.Join(projectionRoot, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(authPath), 0o700); err != nil {
		t.Fatalf("os.MkdirAll(projection) error = %v", err)
	}
	if err := os.WriteFile(authPath, document, 0o600); err != nil {
		t.Fatalf("os.WriteFile(auth projection) error = %v", err)
	}
	return projectionRoot
}

func writeCompositionRegistry(
	t *testing.T,
	aiHomeDir string,
	accountRef string,
	session string,
) string {
	t.Helper()

	socket := "aih-codex-" + accountRef
	document, err := json.Marshal(map[string]any{
		"provider":     "codex",
		"runtimeScope": accountRef,
		"gateway":      false,
		"accountRef":   accountRef,
		"socket":       socket,
		"session":      session,
		"cwd":          aiHomeDir,
	})
	if err != nil {
		t.Fatalf("json.Marshal(registry) error = %v", err)
	}
	directory := filepath.Join(aiHomeDir, "run", "persistent-sessions")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("os.MkdirAll(registry) error = %v", err)
	}
	path := filepath.Join(directory, socket+"--"+session+".json")
	if err := os.WriteFile(path, document, 0o600); err != nil {
		t.Fatalf("os.WriteFile(registry) error = %v", err)
	}
	return path
}

func assertCompositionDeletionRejected(
	t *testing.T,
	client *http.Client,
	baseURL string,
	aiHomeDir string,
	accountRef string,
	registryPath string,
	projectionRoot string,
) {
	t.Helper()

	assertPathExists(t, registryPath, "未确认的 Node session registry")
	assertPathExists(t, projectionRoot, "未提交删除的 auth projection")
	assertSQLiteAccountExists(t, aiHomeDir, accountRef, true)
	assertCompositionAccountSurfaces(
		t,
		client,
		baseURL,
		accountRef,
		compositionTargetModel,
	)
}

func assertCompositionTargetDeleted(
	t *testing.T,
	client *http.Client,
	baseURL string,
	aiHomeDir string,
	accountRef string,
) {
	t.Helper()

	assertSQLiteAccountExists(t, aiHomeDir, accountRef, false)
	tests := []struct {
		name string
		url  string
	}{
		{
			name: "account",
			url:  baseURL + accountsapi.CollectionPath + "/" + accountRef,
		},
		{
			name: "models",
			url: baseURL + accountsapi.CollectionPath + "/" +
				accountRef + "/models",
		},
		{
			name: "usage",
			url: baseURL + accountsapi.CollectionPath + "/" +
				accountRef + "/usage",
		},
		{
			name: "default",
			url:  baseURL + accountsapi.DefaultsPath + "/codex",
		},
	}
	for _, test := range tests {
		exchange := performRequest(
			t,
			client,
			http.MethodGet,
			test.url,
			testManagementKey,
			nil,
		)
		if exchange.status != http.StatusNotFound {
			t.Fatalf("删除后 %s status=%d body=%s", test.name, exchange.status, exchange.body)
		}
	}
	selection := resolveCompositionSelection(t, client, baseURL, accountRef)
	if selection.status != http.StatusNotFound {
		t.Fatalf("删除后 routing status=%d body=%s", selection.status, selection.body)
	}
	models := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+modelsapi.Path,
		testClientKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	if strings.Contains(models.body, `"id":"`+compositionTargetModel+`"`) ||
		!strings.Contains(models.body, `"id":"`+compositionOtherModel+`"`) {
		t.Fatalf("删除后全局模型倒排 = %s", models.body)
	}
}

func assertCompositionAccountSurfaces(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
	modelID string,
) {
	t.Helper()

	account := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef,
		testManagementKey,
		nil,
	)
	assertStatus(t, account, http.StatusOK)
	models := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef+"/models",
		testManagementKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	if !strings.Contains(models.body, `"model_id":"`+modelID+`"`) {
		t.Fatalf("账号模型不可见: %s", models.body)
	}
	usage := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef+"/usage",
		testManagementKey,
		nil,
	)
	assertStatus(t, usage, http.StatusOK)
	if !strings.Contains(usage.body, `"source":"composition_test"`) {
		t.Fatalf("账号 usage 不可见: %s", usage.body)
	}
	defaultAccount := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.DefaultsPath+"/codex",
		testManagementKey,
		nil,
	)
	assertStatus(t, defaultAccount, http.StatusOK)
	if !strings.Contains(defaultAccount.body, accountRef) {
		t.Fatalf("默认账号不是目标账号: %s", defaultAccount.body)
	}
	selection := resolveCompositionSelection(t, client, baseURL, accountRef)
	assertStatus(t, selection, http.StatusOK)
}

func assertCompositionOtherAccountUnaffected(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
) {
	t.Helper()

	account := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef,
		testManagementKey,
		nil,
	)
	assertStatus(t, account, http.StatusOK)
	models := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+accountsapi.CollectionPath+"/"+accountRef+"/models",
		testManagementKey,
		nil,
	)
	assertStatus(t, models, http.StatusOK)
	if !strings.Contains(models.body, `"model_id":"`+compositionOtherModel+`"`) {
		t.Fatalf("其他账号模型受影响: %s", models.body)
	}
	selection := resolveCompositionSelection(t, client, baseURL, accountRef)
	assertStatus(t, selection, http.StatusOK)
}

func resolveCompositionSelection(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
) httpExchange {
	t.Helper()

	payload, err := json.Marshal(map[string]string{
		"provider_id": "codex",
		"account_ref": accountRef,
	})
	if err != nil {
		t.Fatalf("json.Marshal(selection) error = %v", err)
	}
	return performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.SelectionPath,
		testManagementKey,
		payload,
	)
}

func assertSQLiteAccountExists(
	t *testing.T,
	aiHomeDir string,
	rawRef string,
	wantExists bool,
) {
	t.Helper()

	accountRef := parseCompositionAccountRef(t, rawRef)
	withCompositionStore(t, aiHomeDir, func(store *sqliteaccount.Store) {
		_, err := store.GetByRef(context.Background(), accountRef)
		if wantExists && err != nil {
			t.Fatalf("SQLite 账号未保留: %v", err)
		}
		if !wantExists && !errors.Is(err, accountapp.ErrAccountNotFound) {
			t.Fatalf("SQLite 账号删除结果 = %v", err)
		}
	})
}

func withCompositionStore(
	t *testing.T,
	aiHomeDir string,
	use func(*sqliteaccount.Store),
) {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			t.Errorf("Store.Close() error = %v", err)
		}
	}()
	use(store)
}

func parseCompositionAccountRef(
	t *testing.T,
	rawRef string,
) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(rawRef)
	if err != nil {
		t.Fatalf("accounts.ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func awaitSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()

	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal(description + "超时")
	}
}

func assertSignalPending(
	t *testing.T,
	signal <-chan struct{},
	description string,
) {
	t.Helper()

	select {
	case <-signal:
		t.Fatal(description)
	case <-time.After(50 * time.Millisecond):
	}
}

func assertPathExists(t *testing.T, path string, description string) {
	t.Helper()

	if _, err := os.Lstat(path); err != nil {
		t.Fatalf("%s 未保留: %v", description, err)
	}
}

func assertPathMissing(t *testing.T, path string, description string) {
	t.Helper()

	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s 未清理: %v", description, err)
	}
}

var _ accountapp.ProviderModelDiscoverer = (*compositionDeletionDiscoverer)(nil)
