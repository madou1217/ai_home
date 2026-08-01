//go:build !windows

package providercli

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestCodexExternalAuthControllerInitializesAndRefreshes 验证官方 initialize/login/refresh 合同。
func TestCodexExternalAuthControllerInitializesAndRefreshes(t *testing.T) {
	initial := newCodexOAuthFixture(t, "initial-access", "plus")
	refreshed := newCodexOAuthFixture(t, "refreshed-access", "pro")
	accountRef, err := accountcore.DeriveAccountRef(initial)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	refresher := &recordingCredentialRefresher{
		binding: newCredentialBinding(t, accountRef, codex.ProviderID, refreshed),
	}
	runtimeDir, err := os.MkdirTemp("", "aih-codex-test-")
	if err != nil {
		t.Fatalf("MkdirTemp() error = %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDir) })
	socketPath := filepath.Join(runtimeDir, "app.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()

	serverErr := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		request, readErr := http.ReadRequest(reader)
		if readErr != nil {
			serverErr <- readErr
			return
		}
		key := request.Header.Get("Sec-WebSocket-Key")
		if _, writeErr := io.WriteString(connection,
			"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: "+webSocketAccept(key)+"\r\n\r\n",
		); writeErr != nil {
			serverErr <- writeErr
			return
		}
		if err := assertClientRPCMethod(reader, "initialize", "aih-initialize", ""); err != nil {
			serverErr <- err
			return
		}
		if err := writeTestJSONFrame(connection, map[string]any{"id": "aih-initialize", "result": map[string]any{}}); err != nil {
			serverErr <- err
			return
		}
		if err := assertClientRPCMethod(reader, "initialized", "", ""); err != nil {
			serverErr <- err
			return
		}
		if err := assertClientRPCMethod(reader, "account/login/start", "aih-login", "initial-access"); err != nil {
			serverErr <- err
			return
		}
		if err := writeTestJSONFrame(connection, map[string]any{"id": "aih-login", "result": map[string]any{}}); err != nil {
			serverErr <- err
			return
		}
		if err := writeTestJSONFrame(connection, map[string]any{
			"method": "account/chatgptAuthTokens/refresh",
			"id":     17,
			"params": map[string]any{
				"previousAccountId": "workspace-test",
				"reason":            "unauthorized",
			},
		}); err != nil {
			serverErr <- err
			return
		}
		_, _, _, payload, frameErr := readTestFrame(reader)
		if frameErr != nil {
			serverErr <- frameErr
			return
		}
		var response struct {
			ID     int `json:"id"`
			Result struct {
				AccessToken      string `json:"accessToken"`
				ChatGPTAccountID string `json:"chatgptAccountId"`
				ChatGPTPlanType  string `json:"chatgptPlanType"`
			} `json:"result"`
		}
		if jsonErr := json.Unmarshal(payload, &response); jsonErr != nil ||
			response.ID != 17 || response.Result.AccessToken != "refreshed-access" ||
			response.Result.ChatGPTAccountID != "workspace-test" ||
			response.Result.ChatGPTPlanType != "pro" {
			serverErr <- errors.New("刷新响应不符合官方合同")
			return
		}
		serverErr <- nil
	}()

	socket, err := dialUnixWebSocket(t.Context(), socketPath, time.Second)
	if err != nil {
		t.Fatalf("dialUnixWebSocket() error = %v", err)
	}
	controller := &codexExternalAuthController{
		socket:      socket,
		accountRef:  accountRef,
		credentials: refresher,
		accountID:   initial.UpstreamAccountID(),
		planType:    initial.PlanType(),
	}
	if err := controller.Initialize(initial.AccessToken()); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- controller.Serve(context.Background()) }()
	if err := <-serverErr; err != nil {
		t.Fatalf("fake app-server error = %v", err)
	}
	_ = controller.Close()
	if err := <-serveDone; err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Serve() error = %v", err)
	}
	if refresher.CallCount() != 1 || refresher.LastAccountRef() != accountRef {
		t.Fatalf("刷新调用错误: calls=%d ref=%s", refresher.CallCount(), refresher.LastAccountRef())
	}
}

func assertClientRPCMethod(
	reader *bufio.Reader,
	wantMethod string,
	wantID string,
	wantAccessToken string,
) error {
	_, opcode, masked, payload, err := readTestFrame(reader)
	if err != nil || opcode != 0x1 || !masked {
		return errors.New("客户端 RPC 帧错误")
	}
	var envelope struct {
		Method string `json:"method"`
		ID     string `json:"id"`
		Params struct {
			AccessToken      string `json:"accessToken"`
			ChatGPTAccountID string `json:"chatgptAccountId"`
			ChatGPTPlanType  string `json:"chatgptPlanType"`
		} `json:"params"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil ||
		envelope.Method != wantMethod || envelope.ID != wantID {
		return errors.New("客户端 RPC 方法错误")
	}
	if wantAccessToken != "" && (envelope.Params.AccessToken != wantAccessToken ||
		envelope.Params.ChatGPTAccountID != "workspace-test" ||
		envelope.Params.ChatGPTPlanType != "plus") {
		return errors.New("客户端登录参数错误")
	}
	return nil
}

func writeTestJSONFrame(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeTestFrame(writer, true, 0x1, payload, false)
}

type recordingCredentialRefresher struct {
	mu      sync.Mutex
	binding accountapp.CredentialBinding
	err     error
	calls   int
	lastRef accountcore.AccountRef
}

func (refresher *recordingCredentialRefresher) ForceRefreshCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	refresher.mu.Lock()
	defer refresher.mu.Unlock()
	refresher.calls++
	refresher.lastRef = accountRef
	return refresher.binding, refresher.err
}

func (refresher *recordingCredentialRefresher) CallCount() int {
	refresher.mu.Lock()
	defer refresher.mu.Unlock()
	return refresher.calls
}

func (refresher *recordingCredentialRefresher) LastAccountRef() accountcore.AccountRef {
	refresher.mu.Lock()
	defer refresher.mu.Unlock()
	return refresher.lastRef
}

func newCredentialBinding(
	t *testing.T,
	accountRef accountcore.AccountRef,
	providerID string,
	credential accountapp.Credential,
) accountapp.CredentialBinding {
	t.Helper()
	binding, err := accountapp.NewCredentialBinding(accountRef, providerID, credential)
	if err != nil {
		t.Fatalf("NewCredentialBinding() error = %v", err)
	}
	return binding
}

func newCodexOAuthFixture(t *testing.T, accessToken string, planType string) *codex.OAuthAuth {
	t.Helper()
	idToken := testJWT(t, map[string]any{
		"sub": "codex-runtime-user",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":    "codex-runtime-user",
			"chatgpt_account_id": "workspace-test",
			"chatgpt_plan_type":  planType,
		},
	})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       accessToken,
		RefreshToken:      "refresh-secret",
		IDToken:           idToken,
		RefreshedAtMS:     1_700_000_000_000,
		ExplicitAccountID: "workspace-test",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("Marshal(claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}
