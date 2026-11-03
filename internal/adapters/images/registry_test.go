package images

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// fixedSource 按排除表返回候选账号，模拟宿主征召器。
type fixedSource struct {
	accounts []Account
}

func (source fixedSource) Candidates(
	_ context.Context,
	_ string,
	_ string,
	exclude []string,
) ([]Account, error) {
	blocked := map[string]bool{}
	for _, ref := range exclude {
		blocked[ref] = true
	}
	out := make([]Account, 0, len(source.accounts))
	for _, account := range source.accounts {
		if blocked[account.AccountRef] {
			continue
		}
		out = append(out, account)
	}
	return out, nil
}

// fakeDoer 固定返回一个上游响应，不触网。
type fakeDoer struct {
	statusCode int
	body       string
	calls      int
}

func (doer *fakeDoer) Do(request *http.Request) (*http.Response, error) {
	doer.calls++
	return &http.Response{
		StatusCode: doer.statusCode,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(doer.body)),
		Request:    request,
	}, nil
}

func apiKeyAccounts(refs ...string) []Account {
	accounts := make([]Account, 0, len(refs))
	for _, ref := range refs {
		accounts = append(accounts, Account{
			Provider:   "codex",
			AccountRef: ref,
			APIKey:     "sk-test",
			BaseURL:    "http://upstream.test",
			APIKeyMode: true,
		})
	}
	return accounts
}

func imageRequest() imagegeneration.Request {
	return imagegeneration.Request{
		Mode:   imagegeneration.ModeGeneration,
		Model:  "gpt-image-2",
		Prompt: "a single red pixel",
		N:      1,
	}
}

// 换号链必须把「这次是哪把凭据失败了」交出去：上游只回「请求失败」，失败账号是编排层
// 自己选的。没有这条事实，宿主无法给坏账号记冷却（Node 的 markProxyAccountFailure）。
func TestExecuteReportsEveryFailedAccount(t *testing.T) {
	source := fixedSource{accounts: apiKeyAccounts("acct_a", "acct_b")}
	doer := &fakeDoer{statusCode: http.StatusServiceUnavailable, body: `{"error":{"message":"boom"}}`}
	observed := make([]string, 0, 2)

	_, err := Execute(
		context.Background(),
		NewRegistry("", "", nil),
		source,
		"codex",
		imageRequest(),
		ExecuteOptions{
			HTTP: doer,
			AttemptFailure: func(account Account, model string, attemptErr error) {
				observed = append(observed, account.AccountRef+"|"+model+"|"+attemptErr.Error())
			},
		},
	)
	if err == nil {
		t.Fatal("两次 503 之后必须返回错误")
	}
	if len(observed) != 2 {
		t.Fatalf("观察者应收到两条失败，实际 %d: %v", len(observed), observed)
	}
	if observed[0] != "acct_a|gpt-image-2|upstream_error: image API returned status 503" &&
		!strings.HasPrefix(observed[0], "acct_a|gpt-image-2|") {
		t.Fatalf("第一条应为 acct_a 的失败，实际 %q", observed[0])
	}
	if !strings.HasPrefix(observed[1], "acct_b|gpt-image-2|") {
		t.Fatalf("第二条应为 acct_b 的失败，实际 %q", observed[1])
	}
	if doer.calls != 2 {
		t.Fatalf("两个账号各打一次上游，实际 %d 次", doer.calls)
	}
}

// 成功路径不能被观察者多记一次失败。
func TestExecuteDoesNotReportFailureOnSuccess(t *testing.T) {
	source := fixedSource{accounts: apiKeyAccounts("acct_a")}
	doer := &fakeDoer{
		statusCode: http.StatusOK,
		// 1x1 透明 PNG：解析层会校验 base64 真的是受支持的图片。
		body: `{"created":1,"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}]}`,
	}
	called := false

	execution, err := Execute(
		context.Background(),
		NewRegistry("", "", nil),
		source,
		"codex",
		imageRequest(),
		ExecuteOptions{
			HTTP: doer,
			AttemptFailure: func(Account, string, error) {
				called = true
			},
		},
	)
	if err != nil {
		t.Fatalf("成功响应不该报错: %v", err)
	}
	if execution.Account.AccountRef != "acct_a" {
		t.Fatalf("应记录 acct_a，实际 %q", execution.Account.AccountRef)
	}
	if called {
		t.Fatal("成功路径不应触发失败观察者")
	}
}

// 已知 prompt 上限要在网关这一跳拦住：不选号、不打上游，也不能把客户端错误记到账号上。
func TestExecuteRejectsOverlongPromptBeforeAnyAttempt(t *testing.T) {
	source := fixedSource{accounts: []Account{{
		Provider:    "codex",
		AccountRef:  "acct_codex",
		AccessToken: "token",
	}}}
	doer := &fakeDoer{statusCode: http.StatusOK, body: `{"created":1,"data":[]}`}
	observed := 0
	request := imageRequest()
	request.Prompt = strings.Repeat("a", 32001)

	_, err := Execute(
		context.Background(),
		NewRegistry("http://codex.test", "", nil),
		source,
		"codex",
		request,
		ExecuteOptions{
			HTTP: doer,
			AttemptFailure: func(Account, string, error) {
				observed++
			},
		},
	)
	generationErr, ok := AsError(err)
	if !ok || generationErr.StatusCode != http.StatusBadRequest || generationErr.Code != "prompt_too_long" {
		t.Fatalf("应返回 400 prompt_too_long，实际 %#v", err)
	}
	if doer.calls != 0 {
		t.Fatalf("超长 prompt 不该打上游，实际 %d 次", doer.calls)
	}
	if observed != 0 {
		t.Fatalf("超长 prompt 不该记账号失败，实际 %d 次", observed)
	}
}

// 边界：恰好等于上限要放行（否则会把合法请求挡在门外）。
func TestCheckCapabilitiesAllowsPromptAtLimit(t *testing.T) {
	strategy := NewRegistry("", "", nil).Resolve("codex", Account{Provider: "codex"})
	request := imageRequest()
	request.Prompt = strings.Repeat("a", 32000)
	if err := CheckCapabilities(strategy, "codex", request); err != nil {
		t.Fatalf("32000 字符应放行，实际 %v", err)
	}
	request.Prompt = strings.Repeat("a", 32001)
	if err := CheckCapabilities(strategy, "codex", request); err == nil || err.Code != "prompt_too_long" {
		t.Fatalf("32001 字符应判 prompt_too_long，实际 %v", err)
	}
	// 限额属于模型契约，透传上游同样拦（本机 gpt-image-2 走的正是 API-key 中转）。
	passthrough := NewRegistry("", "", nil).Resolve("codex", Account{Provider: "codex", APIKeyMode: true})
	if err := CheckCapabilities(passthrough, "codex", request); err == nil || err.Code != "prompt_too_long" {
		t.Fatalf("透传策略同样应判 prompt_too_long，实际 %v", err)
	}
	// 没登记的模型不猜。
	request.Model = "some-other-image-model"
	if err := CheckCapabilities(strategy, "codex", request); err != nil {
		t.Fatalf("未登记模型不应被 prompt 上限拦住，实际 %v", err)
	}
}
