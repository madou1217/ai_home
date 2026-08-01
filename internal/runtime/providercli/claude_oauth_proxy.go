package providercli

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	claudeOAuthUpstream = "https://api.anthropic.com"
	claudeOAuthBeta     = "oauth-2025-04-20"
)

var ErrClaudeOAuthProxy = errors.New("Claude OAuth 本地认证代理失败")

// claudeOAuthProxy 复用 Claude Code 官方 Unix Socket 通道并只在内存中持有 Token。
type claudeOAuthProxy struct {
	accountRef  accountcore.AccountRef
	credentials CredentialRefresher
	client      *http.Client
	target      *url.URL
	mu          sync.RWMutex
	refreshMu   sync.Mutex
	accessToken string
	tlsConfig   *tls.Config
}

// runClaudeOAuthProxy 为官方 Claude CLI 创建权限收紧的 UDS 认证代理。
func (runner *Runner) runClaudeOAuthProxy(
	ctx context.Context,
	spec providerlaunch.LaunchSpec,
	arguments []string,
) error {
	runtime := spec.Runtime()
	parameters := runtime.RevealParameters()
	if runtime.Kind() != providerlaunch.RuntimeKindClaudeOAuthProxy ||
		parameters["access_token"] == "" {
		return ErrInvalidRunRequest
	}
	if claudeUnsupportedProxyArguments(arguments) {
		return errors.Join(ErrUnsupportedRuntime, errors.New("Claude Remote Control 不支持账号代理 Token"))
	}
	runtimeDir, err := os.MkdirTemp("", "aih-claude-runtime-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(runtimeDir)
	if err := os.Chmod(runtimeDir, 0o700); err != nil {
		return err
	}
	target, err := url.Parse(claudeOAuthUpstream)
	if err != nil {
		return err
	}
	tlsConfig, caCertificate, err := newClaudeOAuthTLSConfig(target.Hostname(), time.Now())
	if err != nil {
		return err
	}
	environment := applyEnvironment(runner.environ(), spec.Environment())
	caBundle := loadClaudeOAuthCABundle(caCertificate, environment)
	caCertificatePath := filepath.Join(runtimeDir, "ca.pem")
	if err := os.WriteFile(caCertificatePath, caBundle, 0o600); err != nil {
		return err
	}
	proxy := &claudeOAuthProxy{
		accountRef:  spec.AccountRef(),
		credentials: runner.credentials,
		client:      runner.httpClient,
		target:      target,
		accessToken: parameters["access_token"],
		tlsConfig:   tlsConfig,
	}
	socketPath := filepath.Join(runtimeDir, "anthropic.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return err
	}
	environment = setEnvironmentValue(environment, "ANTHROPIC_UNIX_SOCKET", socketPath)
	environment = setEnvironmentValue(environment, "NODE_EXTRA_CA_CERTS", caCertificatePath)
	return runner.runWithHTTPProxy(
		ctx,
		listener,
		proxy,
		spec.ProviderID(),
		spec.Binary(),
		arguments,
		environment,
	)
}

// ServeHTTP 注入内存 Token；仅在明确 401 后刷新并重放一次请求。
func (proxy *claudeOAuthProxy) ServeHTTP(writer http.ResponseWriter, incoming *http.Request) {
	if incoming.Method == http.MethodConnect {
		proxy.serveConnect(writer, incoming)
		return
	}
	body, err := readReplayableBody(incoming)
	if err != nil {
		writeProxyError(writer, http.StatusRequestEntityTooLarge, "request body is too large")
		return
	}
	rejectedToken := proxy.currentToken()
	response, err := proxy.forward(incoming.Context(), incoming, body, rejectedToken)
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "upstream request failed")
		return
	}
	if response.StatusCode != http.StatusUnauthorized {
		writeForwardResponse(writer, response)
		return
	}
	unauthorizedBody, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	_ = response.Body.Close()
	if err := proxy.refreshRejected(incoming.Context(), rejectedToken); err != nil {
		response.Body = io.NopCloser(bytes.NewReader(unauthorizedBody))
		response.ContentLength = int64(len(unauthorizedBody))
		writeForwardResponse(writer, response)
		return
	}
	response, err = proxy.forward(incoming.Context(), incoming, body, proxy.currentToken())
	if err != nil {
		writeProxyError(writer, http.StatusBadGateway, "upstream retry failed")
		return
	}
	writeForwardResponse(writer, response)
}

// forward 重建受信目标请求并覆盖所有调用方提供的认证 Header。
func (proxy *claudeOAuthProxy) forward(
	ctx context.Context,
	incoming *http.Request,
	body []byte,
	accessToken string,
) (*http.Response, error) {
	request, err := newForwardRequest(ctx, incoming, proxy.target, body)
	if err != nil {
		return nil, err
	}
	request.Header.Del("x-api-key")
	request.Header.Del("Authorization")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	ensureCommaHeader(request.Header, "anthropic-beta", claudeOAuthBeta)
	return proxy.client.Do(request)
}

// refreshRejected 只刷新仍为当前值的被拒 Token，并合并同一失效 Token 的并发 401。
func (proxy *claudeOAuthProxy) refreshRejected(
	ctx context.Context,
	rejectedToken string,
) error {
	proxy.refreshMu.Lock()
	defer proxy.refreshMu.Unlock()
	if proxy.currentToken() != rejectedToken {
		return nil
	}
	binding, err := proxy.credentials.ForceRefreshCredentialBinding(ctx, proxy.accountRef)
	if err != nil {
		return err
	}
	auth, ok := binding.Credential().(*claude.OAuthAuth)
	if !ok || auth == nil || binding.ProviderID() != claude.ProviderID ||
		binding.AccountRef() != proxy.accountRef {
		return ErrClaudeOAuthProxy
	}
	proxy.mu.Lock()
	proxy.accessToken = auth.AccessToken()
	proxy.mu.Unlock()
	return nil
}

// currentToken 返回受读锁保护的当前 Access Token 快照。
func (proxy *claudeOAuthProxy) currentToken() string {
	proxy.mu.RLock()
	defer proxy.mu.RUnlock()
	return proxy.accessToken
}

// ensureCommaHeader 幂等添加 Claude OAuth 必需 beta，不覆盖其他能力 beta。
func ensureCommaHeader(header http.Header, name string, required string) {
	for _, token := range strings.Split(header.Get(name), ",") {
		if strings.EqualFold(strings.TrimSpace(token), required) {
			return
		}
	}
	if existing := strings.TrimSpace(header.Get(name)); existing != "" {
		header.Set(name, existing+","+required)
	} else {
		header.Set(name, required)
	}
}

// claudeUnsupportedProxyArguments 拒绝无法通过账号代理 Token 安全运行的入口。
func claudeUnsupportedProxyArguments(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--remote-control" || argument == "remote-control" {
			return true
		}
	}
	return false
}

// runWithHTTPProxy 让本地代理与官方 CLI 共用同一 Context 和有界关闭流程。
func (runner *Runner) runWithHTTPProxy(
	ctx context.Context,
	listener net.Listener,
	handler http.Handler,
	providerID string,
	binary string,
	arguments []string,
	environment []string,
) error {
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	serverDone := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serverDone <- err
		close(serverDone)
	}()
	path, err := runner.binaries.Resolve(providerID, binary)
	if err != nil {
		_ = server.Close()
		return err
	}
	process, err := runner.processes.Start(ctx, processSpec{
		path:   path,
		args:   append([]string(nil), arguments...),
		env:    environment,
		stdin:  runner.stdin,
		stdout: runner.stdout,
		stderr: runner.stderr,
	})
	if err != nil {
		_ = server.Close()
		return err
	}
	processDone := waitProcess(process)
	select {
	case err := <-processDone:
		shutdownHTTPServer(server)
		<-serverDone
		return err
	case err := <-serverDone:
		stopProcess(process, processDone)
		if err == nil {
			return ErrClaudeOAuthProxy
		}
		return err
	case <-ctx.Done():
		shutdownHTTPServer(server)
		stopProcess(process, processDone)
		<-serverDone
		return ctx.Err()
	}
}

func shutdownHTTPServer(server *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		_ = server.Close()
	}
}
