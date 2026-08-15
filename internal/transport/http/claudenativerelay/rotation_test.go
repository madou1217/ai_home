package claudenativerelay

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
)

// rotationAccountSource 按固定顺序产出多个账号。
type rotationAccountSource struct {
	refs []accountcore.AccountRef
}

func (source *rotationAccountSource) Accounts(
	context.Context,
	runtimecore.ModelID,
) (AccountCursor, error) {
	return &rotationCursor{refs: source.refs}, nil
}

type rotationCursor struct {
	refs   []accountcore.AccountRef
	offset int
}

func (cursor *rotationCursor) Next(
	context.Context,
) (accountcore.AccountRef, bool, error) {
	if cursor.offset >= len(cursor.refs) {
		return "", false, nil
	}
	ref := cursor.refs[cursor.offset]
	cursor.offset++
	return ref, true, nil
}

// scriptedRelayClient 按调用序号返回不同响应，用于观察是否真的换号重发。
type scriptedRelayClient struct {
	statuses []int
	bodies   []string
	calls    int
}

// TestRelayDelegatesUnchangedBodyWhenScheduledSourceIsEmpty 验证模型没有
// Claude 透传候选时交回 Canonical，且不注入 Claude Code 身份。
func TestRelayDelegatesUnchangedBodyWhenScheduledSourceIsEmpty(t *testing.T) {
	t.Parallel()

	_, credential := newRelayOAuthCredential(t)
	response, delegatedBody, clientCalls := serveScheduledFallbackRequest(
		t,
		nil,
		credential,
	)
	if response.Code != http.StatusAccepted ||
		delegatedBody != scheduledFallbackBody ||
		clientCalls != 0 {
		t.Fatalf(
			"status=%d delegated=%s client_calls=%d",
			response.Code,
			delegatedBody,
			clientCalls,
		)
	}
}

// TestRelayDelegatesUnchangedBodyForUnfitCredential 验证调度到 API Key
// 时保留该账号绑定交回 Canonical，且不泄漏透传身份补丁。
func TestRelayDelegatesUnchangedBodyForUnfitCredential(t *testing.T) {
	t.Parallel()

	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-scheduled-fallback",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	response, delegatedBody, clientCalls := serveScheduledFallbackRequest(
		t,
		[]accountcore.AccountRef{accountRef},
		credential,
	)
	if response.Code != http.StatusAccepted ||
		delegatedBody != scheduledFallbackBody ||
		clientCalls != 0 {
		t.Fatalf(
			"status=%d delegated=%s client_calls=%d",
			response.Code,
			delegatedBody,
			clientCalls,
		)
	}
}

func (client *scriptedRelayClient) Do(*http.Request) (*http.Response, error) {
	index := client.calls
	client.calls++
	if index >= len(client.statuses) {
		index = len(client.statuses) - 1
	}
	return &http.Response{
		StatusCode: client.statuses[index],
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(client.bodies[index])),
	}, nil
}

// TestRelayRotatesToNextAccountOnRetryableFailure 验证透传具备多账号故障转移。
//
// Canonical 路径本就会在可重试失败时换号。透传若只打一次，切到透传就是可用性
// 退化——用户有多个账号，第一个限流即整体失败。
func TestRelayRotatesToNextAccountOnRetryableFailure(t *testing.T) {
	t.Parallel()

	client := &scriptedRelayClient{
		// 529 是可重试的容量不足，第二个账号成功。
		statuses: []int{529, http.StatusOK},
		bodies:   []string{`{"type":"error"}`, `{"ok":true}`},
	}
	response, recorder := serveRotationRequest(t, client, 2)

	if client.calls != 2 {
		t.Fatalf("上游调用次数 = %d, want 2（应换号重发）", client.calls)
	}
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}` {
		t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
	}
	if len(recorder.failures) != 1 {
		t.Fatalf("失败记录数 = %d, want 1（首个账号需进冷却）", len(recorder.failures))
	}
}

// TestRelayDeliversLastUpstreamResponseWhenExhausted 锁定耗尽不得合成错误。
//
// 全部账号都失败时，必须把上游最后说过的话原样还给客户端。合成 502 会把真实的
// 429/529 洗掉，客户端据此立即重试，与限流要求的退避语义相反。
func TestRelayDeliversLastUpstreamResponseWhenExhausted(t *testing.T) {
	t.Parallel()

	client := &scriptedRelayClient{
		statuses: []int{529, 529},
		bodies:   []string{`{"first":true}`, `{"second":true}`},
	}
	response, _ := serveRotationRequest(t, client, 2)

	if client.calls != 2 {
		t.Fatalf("上游调用次数 = %d, want 2", client.calls)
	}
	if response.Code != 529 {
		t.Fatalf("status = %d, want 529（上游真实状态不得被洗掉）", response.Code)
	}
	if response.Body.String() != `{"second":true}` {
		t.Fatalf("body = %q, want 最后一次上游正文", response.Body.String())
	}
	if response.Header().Get(gatewaycontract.RetryAccountHeader) !=
		gatewaycontract.RetryAccountValue {
		t.Fatal("耗尽后缺少换号标记")
	}
}

// TestRelayStopsRotatingOnTerminalFailure 验证不可重试失败不浪费其它账号。
func TestRelayStopsRotatingOnTerminalFailure(t *testing.T) {
	t.Parallel()

	client := &scriptedRelayClient{
		// 400 是请求本身的问题，换号不会改变结果。
		statuses: []int{http.StatusBadRequest, http.StatusOK},
		bodies:   []string{`{"invalid":true}`, `{"ok":true}`},
	}
	response, _ := serveRotationRequest(t, client, 2)

	if client.calls != 1 {
		t.Fatalf("上游调用次数 = %d, want 1（终态失败不应换号）", client.calls)
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

// serveRotationRequest 用调度器账号来源跑一次透传请求。
func serveRotationRequest(
	t *testing.T,
	client HTTPClient,
	accountCount int,
) (*httptest.ResponseRecorder, *relayAttemptRecorder) {
	t.Helper()

	_, credential := newRelayOAuthCredential(t)
	refs := make([]accountcore.AccountRef, 0, accountCount)
	for index := range accountCount {
		refs = append(
			refs,
			accountcore.AccountRef(
				"acct_"+strings.Repeat("0", 19)+string(rune('a'+index)),
			),
		)
	}
	recorder := &relayAttemptRecorder{}
	handler, err := NewHandler(Dependencies{
		Authorizer:     &rotationDenyAuthorizer{},
		Accounts:       &rotationAccountSource{refs: refs},
		Credentials:    &rotationCredentialResolver{credential: credential},
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(`{"model":"claude-opus-5"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	setNativeRelayHeaders(request)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response, recorder
}

const scheduledFallbackBody = `{"model":"gpt-5.6-sol","max_tokens":32,"system":"client-system","messages":[{"role":"user","content":"fallback"}]}`

// serveScheduledFallbackRequest 用无租约调度路径观察 Canonical 回退正文。
func serveScheduledFallbackRequest(
	t *testing.T,
	refs []accountcore.AccountRef,
	credential accountapp.Credential,
) (*httptest.ResponseRecorder, string, int) {
	t.Helper()

	var delegatedBody string
	client := &relayRecordingClient{}
	handler, err := NewHandler(Dependencies{
		Authorizer:  &rotationDenyAuthorizer{},
		Accounts:    &rotationAccountSource{refs: refs},
		Credentials: &rotationCredentialResolver{credential: credential},
		Fallback: http.HandlerFunc(func(
			response http.ResponseWriter,
			request *http.Request,
		) {
			body, readErr := io.ReadAll(request.Body)
			if readErr != nil {
				t.Errorf("io.ReadAll() error = %v", readErr)
			}
			delegatedBody = string(body)
			response.WriteHeader(http.StatusAccepted)
		}),
		Client:         client,
		Attempts:       &relayAttemptRecorder{},
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(scheduledFallbackBody),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response, delegatedBody, client.calls
}

// rotationDenyAuthorizer 始终拒绝租约，迫使请求走调度器账号来源。
type rotationDenyAuthorizer struct{}

func (*rotationDenyAuthorizer) Authorize(
	*http.Request,
) (accountcore.AccountRef, runtimecore.ModelID, bool) {
	return "", "", false
}

// rotationCredentialResolver 为所有被调度到的账号返回同一份合法 OAuth 凭据。
//
// 轮转关注的是「换号后是否真的重发」，凭据差异不在本用例范围内。
type rotationCredentialResolver struct {
	credential accountapp.Credential
}

// ResolveObservedCredentialBinding 对任意账号返回同一份凭据和请求级观察。
func (resolver *rotationCredentialResolver) ResolveObservedCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
	error,
) {
	binding, err := accountapp.NewCredentialBinding(
		accountRef,
		claudeauth.ProviderID,
		resolver.credential,
	)
	if err != nil {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		claudeauth.ProviderID,
		resolver.credential,
		time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC),
	)
	if err != nil {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	return binding, observation, err
}

// IsCurrentCredentialObservation 保持轮转测试聚焦账号切换，不模拟凭据变化。
func (*rotationCredentialResolver) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return true, nil
}
