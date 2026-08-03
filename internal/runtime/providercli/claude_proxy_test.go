//go:build !windows

package providercli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
	claudecli "github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
	codexcli "github.com/madou1217/ai_home/internal/adapters/codex/clilaunch"
)

const (
	initialClaudeToken   = "initial-claude-access-secret"
	refreshedClaudeToken = "refreshed-claude-access-secret"
	claudeRefreshToken   = "claude-refresh-secret"
	testGatewayKey       = "gateway-client-key-with-at-least-32-characters"
)

// TestClaudeOAuthProxyRetriesUnauthorizedAndStreams 验证 401 后只刷新一次并保留 SSE 响应。
func TestClaudeOAuthProxyRetriesUnauthorizedAndStreams(t *testing.T) {
	initial := newClaudeOAuthFixture(t, initialClaudeToken)
	refreshed := newClaudeOAuthFixture(t, refreshedClaudeToken)
	accountRef, err := accountcore.DeriveAccountRef(initial)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	refresher := &recordingCredentialRefresher{
		binding: newCredentialBinding(t, accountRef, claude.ProviderID, refreshed),
	}
	var mu sync.Mutex
	var authorizations []string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		authorizations = append(authorizations, request.Header.Get("Authorization"))
		mu.Unlock()
		if !strings.Contains(request.Header.Get("anthropic-beta"), claudeOAuthBeta) {
			t.Error("缺少 Claude OAuth beta header")
		}
		if request.Header.Get("Authorization") == "Bearer "+initialClaudeToken {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(writer, `{"error":"expired"}`)
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "event: message_start\ndata: {}\n\n")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := &claudeOAuthProxy{
		accountRef:  accountRef,
		credentials: refresher,
		client:      upstream.Client(),
		target:      target,
		accessToken: initialClaudeToken,
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/messages?beta=true", strings.NewReader(`{"stream":true}`))
	request.Header.Set("Authorization", "Bearer forged")
	request.Header.Set("x-api-key", "forged")
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	response := recorder.Result()
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" ||
		string(body) != "event: message_start\ndata: {}\n\n" {
		t.Fatalf("proxy response = status=%d type=%q body=%q", response.StatusCode, response.Header.Get("Content-Type"), body)
	}
	mu.Lock()
	gotAuthorizations := append([]string(nil), authorizations...)
	mu.Unlock()
	want := []string{"Bearer " + initialClaudeToken, "Bearer " + refreshedClaudeToken}
	if len(gotAuthorizations) != len(want) || gotAuthorizations[0] != want[0] || gotAuthorizations[1] != want[1] {
		t.Fatalf("upstream authorizations = %v", gotAuthorizations)
	}
	if refresher.CallCount() != 1 {
		t.Fatalf("refresh calls = %d", refresher.CallCount())
	}
}

// TestClaudeOAuthProxyCoalescesConcurrentUnauthorized 验证同一失效 Token 的并发 401 不重复刷新。
func TestClaudeOAuthProxyCoalescesConcurrentUnauthorized(t *testing.T) {
	initial := newClaudeOAuthFixture(t, initialClaudeToken)
	refreshed := newClaudeOAuthFixture(t, refreshedClaudeToken)
	accountRef, _ := accountcore.DeriveAccountRef(initial)
	refresher := &recordingCredentialRefresher{
		binding: newCredentialBinding(t, accountRef, claude.ProviderID, refreshed),
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") == "Bearer "+initialClaudeToken {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := &claudeOAuthProxy{
		accountRef:  accountRef,
		credentials: refresher,
		client:      upstream.Client(),
		target:      target,
		accessToken: initialClaudeToken,
	}
	var group sync.WaitGroup
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			recorder := httptest.NewRecorder()
			proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/messages", nil))
			if recorder.Code != http.StatusOK {
				t.Errorf("status = %d", recorder.Code)
			}
		}()
	}
	group.Wait()
	if refresher.CallCount() != 1 {
		t.Fatalf("concurrent refresh calls = %d", refresher.CallCount())
	}
}

// TestClaudeOAuthProxyTerminatesConnectAndInjectsSecret 验证官方 UDS CONNECT/TLS 合同及内层认证覆盖。
func TestClaudeOAuthProxyTerminatesConnectAndInjectsSecret(t *testing.T) {
	var gotAuthorization, gotAPIKey, gotBeta string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotAuthorization = request.Header.Get("Authorization")
		gotAPIKey = request.Header.Get("x-api-key")
		gotBeta = request.Header.Get("anthropic-beta")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "ok")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	tlsConfig, caCertificate, err := newClaudeOAuthTLSConfig(target.Hostname(), time.Now())
	if err != nil {
		t.Fatalf("newClaudeOAuthTLSConfig() error = %v", err)
	}
	proxy := &claudeOAuthProxy{
		credentials: &recordingCredentialRefresher{},
		client:      upstream.Client(),
		target:      target,
		accessToken: initialClaudeToken,
		tlsConfig:   tlsConfig,
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen() error = %v", err)
	}
	server := &http.Server{Handler: proxy}
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.Serve(listener) }()
	t.Cleanup(func() {
		_ = server.Close()
		<-serverDone
	})

	connection, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatalf("net.Dial() error = %v", err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "CONNECT "+target.Host+" HTTP/1.1\r\nHost: "+target.Host+"\r\n\r\n"); err != nil {
		t.Fatalf("write CONNECT error = %v", err)
	}
	connectResponse, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatalf("ReadResponse(CONNECT) error = %v", err)
	}
	if connectResponse.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d", connectResponse.StatusCode)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caCertificate) {
		t.Fatal("临时 CA 无法加入客户端信任池")
	}
	tlsConnection := tls.Client(connection, &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
		ServerName: target.Hostname(),
		NextProtos: []string{"http/1.1"},
	})
	if err := tlsConnection.Handshake(); err != nil {
		t.Fatalf("TLS Handshake() error = %v", err)
	}
	request, _ := http.NewRequest(http.MethodPost, "https://"+target.Host+"/v1/messages?beta=true", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer forged")
	request.Header.Set("x-api-key", "forged")
	request.Header.Set("anthropic-beta", "claude-code-20250219")
	if err := request.Write(tlsConnection); err != nil {
		t.Fatalf("request.Write() error = %v", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(tlsConnection), request)
	if err != nil {
		t.Fatalf("ReadResponse(POST) error = %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(body) != "ok" ||
		gotAuthorization != "Bearer "+initialClaudeToken || gotAPIKey != "" ||
		!strings.Contains(gotBeta, "claude-code-20250219") || !strings.Contains(gotBeta, claudeOAuthBeta) {
		t.Fatalf(
			"TLS proxy result: status=%d body=%q authorization=%q apiKey=%q beta=%q",
			response.StatusCode,
			body,
			gotAuthorization,
			gotAPIKey,
			gotBeta,
		)
	}
}

// TestClaudeOAuthProxyRejectsUnexpectedConnectTarget 验证 UDS 不能转发任意目标。
func TestClaudeOAuthProxyRejectsUnexpectedConnectTarget(t *testing.T) {
	target, _ := url.Parse(claudeOAuthUpstream)
	tlsConfig, _, err := newClaudeOAuthTLSConfig(target.Hostname(), time.Now())
	if err != nil {
		t.Fatalf("newClaudeOAuthTLSConfig() error = %v", err)
	}
	proxy := &claudeOAuthProxy{target: target, tlsConfig: tlsConfig}
	request := httptest.NewRequest(http.MethodConnect, "http://example.com", nil)
	request.Host = "example.com:443"
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("unexpected CONNECT status = %d", recorder.Code)
	}
}

// TestClaudeGatewayProxyForcesPinnedAccountAndSecret 验证用户 Header 不能覆盖固定账号和 Server Key。
func TestClaudeGatewayProxyForcesPinnedAccountAndSecret(t *testing.T) {
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	var gotKey, gotAccount, gotAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotKey = request.Header.Get("x-api-key")
		gotAccount = request.Header.Get(pinnedAccountHeader)
		gotAuthorization = request.Header.Get("Authorization")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, "ok")
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := &claudeGatewayProxy{
		target:      target,
		clientKey:   testGatewayKey,
		accountRef:  accountRef,
		localSecret: "local-random-secret",
		client:      upstream.Client(),
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader("{}"))
	request.Header.Set("x-api-key", "local-random-secret")
	request.Header.Set("Authorization", "Bearer forged")
	request.Header.Set(pinnedAccountHeader, "acct_ffffffffffffffffffff")
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || gotKey != testGatewayKey ||
		gotAccount != accountRef.String() || gotAuthorization != "" {
		t.Fatalf("forwarded headers: status=%d key=%q account=%q authorization=%q", recorder.Code, gotKey, gotAccount, gotAuthorization)
	}
}

// TestClaudeProxyRuntimesKeepRealSecretsOutOfChildEnvironment 验证 Native OAuth 与固定 Gateway 的真实密钥仅留在代理内存。
func TestClaudeProxyRuntimesKeepRealSecretsOutOfChildEnvironment(t *testing.T) {
	t.Run("Native OAuth", func(t *testing.T) {
		auth := newClaudeOAuthFixture(t, initialClaudeToken)
		spec := buildClaudeNativeSpec(t, auth)
		processes := newCapturingProcessFactory()
		runner := newTestRunner(t, &recordingCredentialRefresher{}, processes)
		inheritedCAPath := filepath.Join(t.TempDir(), "existing-ca.pem")
		_, inheritedCA, err := newClaudeOAuthTLSConfig("existing.example.com", time.Now())
		if err != nil {
			t.Fatalf("创建测试 CA 失败: %v", err)
		}
		if err := os.WriteFile(inheritedCAPath, inheritedCA, 0o600); err != nil {
			t.Fatalf("写入测试 CA 失败: %v", err)
		}
		runner.environ = func() []string {
			return []string{
				"CLAUDE_CONFIG_DIR=/shared/claude",
				"CODEX_HOME=/shared/codex",
				"NODE_EXTRA_CA_CERTS=" + inheritedCAPath,
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- runner.runClaudeOAuthProxy(ctx, spec, nil) }()
		started := <-processes.started
		environment := environmentMap(started.env)
		if strings.Contains(strings.Join(started.env, "\n"), initialClaudeToken) ||
			strings.Contains(strings.Join(started.env, "\n"), claudeRefreshToken) ||
			environment["CLAUDE_CODE_OAUTH_TOKEN"] != "aih-managed-oauth" ||
			environment["ANTHROPIC_UNIX_SOCKET"] == "" {
			t.Fatalf("Native OAuth child env 泄漏或缺失: %v", environmentKeys(environment))
		}
		if environment["CLAUDE_CONFIG_DIR"] != "/shared/claude" {
			t.Fatalf("Native OAuth 必须继承共享 CLAUDE_CONFIG_DIR: %q", environment["CLAUDE_CONFIG_DIR"])
		}
		caCertificatePath := environment["NODE_EXTRA_CA_CERTS"]
		info, statErr := os.Stat(caCertificatePath)
		if caCertificatePath == "" || statErr != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("Native OAuth 临时 CA 缺失或权限错误: path=%q err=%v", caCertificatePath, statErr)
		}
		caCertificate, readErr := os.ReadFile(caCertificatePath)
		caCount := 0
		remaining := caCertificate
		for {
			block, rest := pem.Decode(remaining)
			if block == nil {
				break
			}
			certificate, parseErr := x509.ParseCertificate(block.Bytes)
			if parseErr == nil && certificate.IsCA {
				caCount++
			}
			remaining = rest
		}
		if readErr != nil || caCount != 2 || !bytes.Contains(caCertificate, inheritedCA) {
			t.Fatalf("Native OAuth 临时 CA 无效: err=%v", readErr)
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("runClaudeOAuthProxy() error = %v", err)
		}
		if _, err := os.Stat(caCertificatePath); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Native OAuth 临时 CA 未随 Runtime 清理: %v", err)
		}
	})

	t.Run("Pinned Gateway", func(t *testing.T) {
		spec := buildClaudeGatewaySpec(t)
		processes := newCapturingProcessFactory()
		runner := newTestRunner(t, &recordingCredentialRefresher{}, processes)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- runner.runClaudePinnedGateway(ctx, spec, nil) }()
		started := <-processes.started
		environment := environmentMap(started.env)
		if strings.Contains(strings.Join(started.env, "\n"), testGatewayKey) ||
			environment["ANTHROPIC_API_KEY"] == "" ||
			!strings.HasPrefix(environment["ANTHROPIC_BASE_URL"], "http://127.0.0.1:") {
			t.Fatalf("Pinned Gateway child env 泄漏或缺失: %v", environmentKeys(environment))
		}
		if _, found := environment["ANTHROPIC_CUSTOM_HEADERS"]; found {
			t.Fatal("固定账号 Header 必须由本地代理强制注入")
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("runClaudePinnedGateway() error = %v", err)
		}
	})
}

// TestRunnerUsesClientProviderForCrossProviderRelay 验证 Codex 到 Claude 的 Relay 仍启动 Codex，并保留 Claude 固定账号。
func TestRunnerUsesClientProviderForCrossProviderRelay(t *testing.T) {
	catalog := testProviderCatalog(t)
	auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: "synthetic-cross-provider-key"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	accountID, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity: auth, CLIAccountID: accountID, CreatedAt: time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	gateway, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Accounts:   fixedGatewayAccountResolver{account: account},
		Strategies: []providerlaunch.GatewayStrategy{codexcli.NewGatewayStrategy()},
	})
	if err != nil {
		t.Fatalf("NewGatewayPlanner() error = %v", err)
	}
	service, err := providerlaunch.NewService(providerlaunch.ServiceDependencies{
		Native:  unreachableNativeBuilder{},
		Gateway: gateway,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	intent, err := providerlaunch.ParseLaunchIntent(
		catalog,
		"codex",
		[]string{"relay", "claude", "9", "--model", "claude-opus-5"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	endpoint, err := providerlaunch.NewGatewayEndpoint("http://127.0.0.1:9527", testGatewayKey)
	if err != nil {
		t.Fatalf("NewGatewayEndpoint() error = %v", err)
	}
	plan, err := service.Plan(context.Background(), intent, endpoint)
	if err != nil {
		t.Fatalf("Plan() error = %v", err)
	}

	processes := &completedProcessFactory{}
	runner := newTestRunner(t, &recordingCredentialRefresher{}, processes)
	if err := runner.Run(context.Background(), plan, intent.Arguments()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	environment := environmentMap(processes.spec.env)
	if processes.calls != 1 || processes.spec.path != "/official/codex" ||
		!containsArgumentPair(processes.spec.args, "--model", "claude-opus-5") ||
		environment["AIH_GATEWAY_ACCOUNT_REF"] != account.Ref().String() ||
		environment["CODEX_HOME"] != "/shared/codex" {
		t.Fatalf("process path=%q args=%v envKeys=%v", processes.spec.path, processes.spec.args, environmentKeys(environment))
	}
}

func newClaudeOAuthFixture(t *testing.T, accessToken string) *claude.OAuthAuth {
	t.Helper()
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  accessToken,
		RefreshToken: claudeRefreshToken,
		ExpiresAtMS:  time.Now().Add(time.Hour).UnixMilli(),
		Scopes:       []string{"user:inference", "user:profile"},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func buildClaudeNativeSpec(t *testing.T, credential accountapp.Credential) providerlaunch.LaunchSpec {
	t.Helper()
	catalog := testProviderCatalog(t)
	accountID, _ := accountcore.NewCLIAccountID(9)
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity: credential, CLIAccountID: accountID, CreatedAt: time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	selection, _ := accountapp.NewLaunchSelection(account, accountapp.LaunchSelectionSourceCLIAccountID)
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    fixedAccountSelector{selection: selection},
		Credentials: fixedBindingResolver{binding: newCredentialBinding(t, account.Ref(), claude.ProviderID, credential)},
		Strategies:  []providerlaunch.Strategy{claudecli.NewStrategy()},
	})
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	spec, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
		ProviderID: claude.ProviderID, CLIAccountID: accountID,
	})
	if err != nil {
		t.Fatalf("Planner.Build() error = %v", err)
	}
	return spec
}

func buildClaudeGatewaySpec(t *testing.T) providerlaunch.GatewayLaunchSpec {
	t.Helper()
	catalog := testProviderCatalog(t)
	auth := newClaudeOAuthFixture(t, initialClaudeToken)
	accountID, _ := accountcore.NewCLIAccountID(9)
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity: auth, CLIAccountID: accountID, CreatedAt: time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	planner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Accounts:   fixedGatewayAccountResolver{account: account},
		Strategies: []providerlaunch.GatewayStrategy{claudecli.NewGatewayStrategy()},
	})
	if err != nil {
		t.Fatalf("NewGatewayPlanner() error = %v", err)
	}
	intent, _ := providerlaunch.ParseLaunchIntent(catalog, claude.ProviderID, []string{"relay", "9"})
	endpoint, _ := providerlaunch.NewGatewayEndpoint("http://127.0.0.1:9527", testGatewayKey)
	spec, err := planner.Build(context.Background(), intent, endpoint)
	if err != nil {
		t.Fatalf("GatewayPlanner.Build() error = %v", err)
	}
	return spec
}

type fixedAccountSelector struct{ selection accountapp.LaunchSelection }

func (selector fixedAccountSelector) Resolve(context.Context, accountapp.LaunchSelectionRequest) (accountapp.LaunchSelection, error) {
	return selector.selection, nil
}

type fixedBindingResolver struct{ binding accountapp.CredentialBinding }

func (resolver fixedBindingResolver) ResolveCredentialBinding(context.Context, accountcore.AccountRef) (accountapp.CredentialBinding, error) {
	return resolver.binding, nil
}

type fixedGatewayAccountResolver struct{ account accountcore.Account }

func (resolver fixedGatewayAccountResolver) GetByCLIAccountID(context.Context, string, accountcore.CLIAccountID) (accountcore.Account, error) {
	return resolver.account, nil
}

// unreachableNativeBuilder 保证跨 Provider Gateway 测试不会越界进入 Native 分支。
type unreachableNativeBuilder struct{}

func (unreachableNativeBuilder) Build(context.Context, accountapp.LaunchSelectionRequest) (providerlaunch.LaunchSpec, error) {
	return providerlaunch.LaunchSpec{}, errors.New("不应调用 Native 规划器")
}

func testProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// capturingProcessFactory 捕获官方 CLI 子进程描述而不启动真实进程。
type capturingProcessFactory struct{ started chan processSpec }

// newCapturingProcessFactory 创建带单次启动缓冲的测试工厂。
func newCapturingProcessFactory() *capturingProcessFactory {
	return &capturingProcessFactory{started: make(chan processSpec, 1)}
}

// Start 保存进程描述并返回可由取消流程终止的句柄。
func (factory *capturingProcessFactory) Start(_ context.Context, spec processSpec) (processHandle, error) {
	factory.started <- spec
	return newBlockingProcess(), nil
}

// completedProcessFactory 同步捕获一次直接进程启动。
type completedProcessFactory struct {
	spec  processSpec
	calls int
}

func (factory *completedProcessFactory) Start(_ context.Context, spec processSpec) (processHandle, error) {
	factory.calls++
	factory.spec = spec
	return completedProcess{}, nil
}

// completedProcess 表示已正常退出的官方 CLI 测试进程。
type completedProcess struct{}

func (completedProcess) Wait() error            { return nil }
func (completedProcess) Signal(os.Signal) error { return nil }
func (completedProcess) Kill() error            { return nil }

// blockingProcess 模拟持续运行直到收到 Signal 或 Kill 的官方 CLI。
type blockingProcess struct {
	once sync.Once
	done chan struct{}
}

// newBlockingProcess 创建尚未结束的测试进程。
func newBlockingProcess() *blockingProcess { return &blockingProcess{done: make(chan struct{})} }

// Wait 阻塞到测试 Runtime 请求终止。
func (process *blockingProcess) Wait() error { <-process.done; return nil }

// Signal 模拟优雅终止并解除 Wait。
func (process *blockingProcess) Signal(_ os.Signal) error { process.signal(); return nil }

// signal 幂等关闭测试进程。
func (process *blockingProcess) signal() { process.once.Do(func() { close(process.done) }) }

// Kill 模拟强制终止并解除 Wait。
func (process *blockingProcess) Kill() error { process.signal(); return nil }

func newTestRunner(t *testing.T, refresher CredentialRefresher, processes processFactory) *Runner {
	t.Helper()
	runner, err := NewRunner(Options{
		Credentials: refresher,
		Stdin:       bytes.NewReader(nil), Stdout: io.Discard, Stderr: io.Discard,
	})
	if err != nil {
		t.Fatalf("NewRunner() error = %v", err)
	}
	runner.environ = func() []string { return []string{"CLAUDE_CONFIG_DIR=/shared/claude", "CODEX_HOME=/shared/codex"} }
	runner.binaries = binaryResolver{
		lookupEnv: func(string) (string, bool) { return "", false },
		lookPath:  func(binary string) (string, error) { return "/official/" + binary, nil },
	}
	runner.processes = processes
	return runner
}

func environmentMap(values []string) map[string]string {
	result := make(map[string]string, len(values))
	for _, entry := range values {
		name, value, found := strings.Cut(entry, "=")
		if found {
			result[name] = value
		}
	}
	return result
}

func environmentKeys(values map[string]string) []string {
	result := make([]string, 0, len(values))
	for name := range values {
		result = append(result, name)
	}
	return result
}

// containsArgumentPair 判断官方参数中是否存在相邻的名称和值。
func containsArgumentPair(arguments []string, name string, value string) bool {
	for index := 0; index+1 < len(arguments); index++ {
		if arguments[index] == name && arguments[index+1] == value {
			return true
		}
	}
	return false
}
