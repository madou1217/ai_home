package qoderrelay

// 本文件是 qoder relay 的 **Handler 级**端到端契约：请求从 /v1/chat/completions 进入，
// 经过 relaycore 的账号选择 → Provider 改写/签名/压缩 → 真发 HTTP 到假上游 → 响应交付，
// 同时断言「假上游收到什么」「客户端拿到什么」「运行态记了什么」。
//
// 跑在 Handler 这一层而不是 Provider 层，是因为最容易出错的三件事都发生在编排里：
//   - 记账时机：200 + 首帧排队必须在 recordSuccess **之前**判定，否则账号被记成健康；
//   - 交付形态：排队要回 429 + Retry-After，而不是把上游 403 原样透给客户端；
//   - 失败分类：403 + 10605 是容量问题，绝不能落进「凭据被拒 → 硬阻塞账号」。
//
// 假上游与假 wasm 签名运行时复用 conformance_test.go 的装配（同样的签名覆盖校验、
// 同样的 zstd 解压核对），所以这里不再重复协议形状断言。

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// handlerE2EPath 是 chat completions 入口（qoder 只在该入口声明了 Go 透传）。
	handlerE2EPath = "/v1/chat/completions"
	// handlerE2EAccountRef 是假征召器产出的账号（格式与生产同形）。
	handlerE2EAccountRef accountcore.AccountRef = "acct_0000000000000000000a"
)

// handlerE2EAccounts 按固定顺序产出账号（只会有一个）。
type handlerE2EAccounts struct {
	refs []accountcore.AccountRef
}

func (accounts *handlerE2EAccounts) Accounts(
	context.Context,
	runtimecore.ModelID,
) (relaycore.AccountCursor, error) {
	return &handlerE2ECursor{refs: accounts.refs}, nil
}

type handlerE2ECursor struct {
	refs  []accountcore.AccountRef
	index int
}

func (cursor *handlerE2ECursor) Next(context.Context) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.index >= len(cursor.refs) {
		return "", false, nil
	}
	ref := cursor.refs[cursor.index]
	cursor.index++
	return ref, true, nil
}

// handlerE2ECredentials 返回真实形态的绑定与观察：Handler 会校验两者身份一致。
type handlerE2ECredentials struct {
	credential accountapp.Credential
}

func (resolver *handlerE2ECredentials) ResolveObservedCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error) {
	providerID := resolver.credential.ProviderID()
	binding, err := accountapp.NewCredentialBinding(accountRef, providerID, resolver.credential)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		providerID,
		resolver.credential,
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	return binding, observation, nil
}

func (*handlerE2ECredentials) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return true, nil
}

// handlerE2EAttempts 记录运行态写入，用来钉住「记账发生在什么时机」。
type handlerE2EAttempts struct {
	mutex     sync.Mutex
	successes int
	failures  []runtimecore.FailureKind
}

func (attempts *handlerE2EAttempts) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptSuccess,
) error {
	attempts.mutex.Lock()
	defer attempts.mutex.Unlock()
	attempts.successes++
	return nil
}

func (attempts *handlerE2EAttempts) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	attempts.mutex.Lock()
	defer attempts.mutex.Unlock()
	attempts.failures = append(attempts.failures, failure.RuntimeKind())
	return nil
}

func (attempts *handlerE2EAttempts) snapshot() (int, []runtimecore.FailureKind) {
	attempts.mutex.Lock()
	defer attempts.mutex.Unlock()
	return attempts.successes, append([]runtimecore.FailureKind(nil), attempts.failures...)
}

// handlerE2EFallback 记录「交回 Canonical」，正常用例里它不该被调用。
type handlerE2EFallback struct {
	calls int
}

func (fallback *handlerE2EFallback) ServeHTTP(writer http.ResponseWriter, _ *http.Request) {
	fallback.calls++
	writer.WriteHeader(http.StatusBadGateway)
}

// newHandlerE2E 装配与 composition.go 同形的 Handler：同一条 ProviderChain、账号来源、
// 凭据端口、真实 HTTP 客户端与运行态记录器。
func newHandlerE2E(
	t *testing.T,
	provider relaycore.Provider,
	credential accountapp.Credential,
	attempts *handlerE2EAttempts,
	fallback *handlerE2EFallback,
) *relaycore.Handler {
	t.Helper()
	handler, err := relaycore.NewHandler(relaycore.Dependencies{
		Provider:    relaycore.NewProviderChain(provider),
		Path:        handlerE2EPath,
		Accounts:    &handlerE2EAccounts{refs: []accountcore.AccountRef{handlerE2EAccountRef}},
		Fallback:    fallback,
		Credentials: &handlerE2ECredentials{credential: credential},
		Client:      &http.Client{Timeout: 10 * time.Second},
		Attempts:    attempts,
		Clock:       func() time.Time { return time.Unix(1_700_000_100, 0) },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// serveE2E 发一次真实的 chat completions 请求。
func serveE2E(t *testing.T, handler *relaycore.Handler) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPost,
		handlerE2EPath,
		bytes.NewReader(conformanceRequestPayload()),
	)
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// TestHandlerEndToEndStreamSuccess 覆盖完整成功链路：签名（含设备令牌）→ zstd →
// 上游 SSE 信封 → 拆包交付，并断言成功记账恰好一次。
func TestHandlerEndToEndStreamSuccess(t *testing.T) {
	setup := newConformanceSetup(t, http.StatusOK, conformanceSuccessStream(t))
	credential := nativeCredential(t, conformanceProviderID)
	attempts := &handlerE2EAttempts{}
	fallback := &handlerE2EFallback{}
	handler := newHandlerE2E(t, setup.provider, credential, attempts, fallback)

	recorder := serveE2E(t, handler)

	setup.assertUpstreamContract(t)
	if fallback.calls != 0 {
		t.Fatalf("成功请求被交回 Canonical %d 次", fallback.calls)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("客户端状态码 = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	frames := conformanceClientFrames(t, recorder.Body.String())
	if len(frames) != 5 || frames[len(frames)-1] != "[DONE]" {
		t.Fatalf("客户端帧 = %v, want 4 个 chunk + [DONE]", frames)
	}
	for _, frame := range frames[:len(frames)-1] {
		var chunk struct {
			ID     string `json:"id"`
			Object string `json:"object"`
		}
		if err := json.Unmarshal([]byte(frame), &chunk); err != nil {
			t.Fatalf("帧不是合法 JSON chunk: %v (%q)", err, frame)
		}
		if chunk.Object != "chat.completion.chunk" || chunk.ID != conformanceChunkID {
			t.Fatalf("信封未被拆开: %q", frame)
		}
	}
	successes, failures := attempts.snapshot()
	if successes != 1 || len(failures) != 0 {
		t.Fatalf("运行态记账 = %d 成功 / %v 失败，want 1 / 0", successes, failures)
	}
}

// TestHandlerQueueFirstFrameSkipsSuccess 覆盖「200 + SSE 首帧排队」：必须在记账前
// 判定，客户端拿到 429 + Retry-After，账号不得被记成健康。
func TestHandlerQueueFirstFrameSkipsSuccess(t *testing.T) {
	frames := []byte("data: " + nestedQueuePayload(t, 30) + "\n\ndata: [DONE]\n\n")
	setup := newConformanceSetup(t, http.StatusOK, frames)
	credential := nativeCredential(t, conformanceProviderID)
	attempts := &handlerE2EAttempts{}
	fallback := &handlerE2EFallback{}
	handler := newHandlerE2E(t, setup.provider, credential, attempts, fallback)

	recorder := serveE2E(t, handler)

	setup.assertUpstreamContract(t)
	if fallback.calls != 0 {
		t.Fatalf("排队失败被交回 Canonical %d 次", fallback.calls)
	}
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("客户端状态码 = %d, want 429: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != "30" {
		t.Fatalf("Retry-After = %q, want 30", got)
	}
	if got := recorder.Header().Get(queueIndicatorHeader); got != "1" {
		t.Fatalf("%s = %q, want 1", queueIndicatorHeader, got)
	}
	if !strings.Contains(recorder.Body.String(), queueFailureCode) {
		t.Fatalf("错误码 %q 未交付: %s", queueFailureCode, recorder.Body.String())
	}
	// 首帧就被判定为失败：正文里不能出现任何 chunk（客户端不该看到半条回答）。
	if strings.Contains(recorder.Body.String(), "chat.completion") {
		t.Fatalf("排队失败被伪装成回答: %s", recorder.Body.String())
	}
	successes, failures := attempts.snapshot()
	if successes != 0 {
		t.Fatalf("排队响应被记成成功 %d 次（必须发生在 recordSuccess 之前）", successes)
	}
	if len(failures) != 1 || failures[0] != runtimecore.FailureModelOverloaded {
		t.Fatalf("失败记账 = %v, want [model_overloaded]", failures)
	}
}

// TestHandlerQueueStatusBecomes429 覆盖真机形态：上游直接回 HTTP 403 + 10605。
//
// 两条断言缺一不可：
//   - 客户端拿 429 + Retry-After，而不是把 403 当成「网关拒绝」；
//   - 账号记 model_overloaded（模型级冷却），而不是 credential_rejected（硬阻塞）。
//     后者会把一个健康账号从池子里摘掉，Node 侧注释称之为「把健康账号锁一年」。
func TestHandlerQueueStatusBecomes429(t *testing.T) {
	setup := newConformanceSetup(t, http.StatusForbidden, []byte(nestedQueuePayload(t, 45)))
	credential := nativeCredential(t, conformanceProviderID)
	attempts := &handlerE2EAttempts{}
	fallback := &handlerE2EFallback{}
	handler := newHandlerE2E(t, setup.provider, credential, attempts, fallback)

	recorder := serveE2E(t, handler)

	setup.assertUpstreamContract(t)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("客户端状态码 = %d, want 429: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != "45" {
		t.Fatalf("Retry-After = %q, want 45", got)
	}
	if got := recorder.Header().Get(queueIndicatorHeader); got != "1" {
		t.Fatalf("%s = %q, want 1", queueIndicatorHeader, got)
	}
	successes, failures := attempts.snapshot()
	if successes != 0 {
		t.Fatalf("排队 403 被记成成功 %d 次", successes)
	}
	if len(failures) != 1 || failures[0] != runtimecore.FailureModelOverloaded {
		t.Fatalf("失败记账 = %v, want [model_overloaded]（不能是 credential_rejected）", failures)
	}
}

// TestHandlerNonQueueHTTPErrorPassesThrough 钉住「不误伤」：普通 401 必须原样透传
// 状态码与正文，客户端才能看到真实的鉴权原因。
func TestHandlerNonQueueHTTPErrorPassesThrough(t *testing.T) {
	body := []byte(`{"error":{"code":"invalid_token","message":"token expired"}}`)
	setup := newConformanceSetup(t, http.StatusUnauthorized, body)
	credential := nativeCredential(t, conformanceProviderID)
	attempts := &handlerE2EAttempts{}
	fallback := &handlerE2EFallback{}
	handler := newHandlerE2E(t, setup.provider, credential, attempts, fallback)

	recorder := serveE2E(t, handler)

	setup.assertUpstreamContract(t)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("客户端状态码 = %d, want 401（上游错误必须原样透出）", recorder.Code)
	}
	if got := recorder.Body.String(); !strings.Contains(got, "token expired") {
		t.Fatalf("上游错误正文未透传: %s", got)
	}
	successes, failures := attempts.snapshot()
	if successes != 0 {
		t.Fatalf("401 被记成成功 %d 次", successes)
	}
	if len(failures) != 1 || failures[0] != runtimecore.FailureCredentialRejected {
		t.Fatalf("失败记账 = %v, want [credential_rejected]", failures)
	}
}
