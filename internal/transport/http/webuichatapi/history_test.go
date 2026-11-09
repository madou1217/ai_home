package webuichatapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// 内部入口只接受带管理凭据的调用：没有鉴权时任何本机进程都能消耗账号额度。
func TestHandlerRejectsUnauthorizedInternalCalls(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA},
		respondWith(sseResponse(okStream()), nil), func(dependencies *Dependencies) {
			dependencies.Authorizer = denyAuthorizer{}
		})
	recorder := testRig.post(t, submitBody, nil)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d, want 401, body = %s", recorder.Code, recorder.Body.String())
	}
	body := decodeRouteError(t, recorder)
	if body.Error != "chat_runtime_unauthorized" {
		t.Fatalf("错误码 = %q", body.Error)
	}
	if requests, _ := testRig.client.sent(); len(requests) != 0 {
		t.Fatalf("未授权请求不应触达上游，实际 %d 次", len(requests))
	}
}

// 每个必需端口缺一都必须装配期失败：运行期才发现依赖缺失时，请求已经进入上游链路。
func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	base := func() Dependencies {
		return Dependencies{
			Authorizer:  allowAllAuthorizer{},
			Accounts:    &testAccounts{},
			Credentials: &testCredentials{provider: "openai"},
			Provider:    newTestProvider("https://upstream.test/v1/chat/completions"),
			Client:      &testClient{},
			Attempts:    &testAttempts{},
			Clock:       func() time.Time { return time.Unix(1_700_000_000, 0) },
		}
	}
	if _, err := NewHandler(base()); err != nil {
		t.Fatalf("基线依赖装配失败: %v", err)
	}
	cases := map[string]func(*Dependencies){
		"authorizer":  func(dependencies *Dependencies) { dependencies.Authorizer = nil },
		"accounts":    func(dependencies *Dependencies) { dependencies.Accounts = nil },
		"credentials": func(dependencies *Dependencies) { dependencies.Credentials = nil },
		"provider":    func(dependencies *Dependencies) { dependencies.Provider = nil },
		"client":      func(dependencies *Dependencies) { dependencies.Client = nil },
		"attempts":    func(dependencies *Dependencies) { dependencies.Attempts = nil },
		"clock":       func(dependencies *Dependencies) { dependencies.Clock = nil },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			dependencies := base()
			mutate(&dependencies)
			if _, err := NewHandler(dependencies); !errors.Is(err, ErrInvalidDependencies) {
				t.Fatalf("NewHandler() error = %v, want ErrInvalidDependencies", err)
			}
		})
	}
}

// 鉴权是必需依赖：缺它必须在装配期失败，而不是运行期放行。
func TestNewHandlerRequiresAuthorizer(t *testing.T) {
	_, err := NewHandler(Dependencies{
		Accounts:    &testAccounts{},
		Credentials: &testCredentials{provider: "openai"},
		Provider:    newTestProvider("https://upstream.test/v1/chat/completions"),
		Client:      &testClient{},
		Attempts:    &testAttempts{},
		Clock:       func() time.Time { return time.Unix(1_700_000_000, 0) },
	})
	if !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v, want ErrInvalidDependencies", err)
	}
}

// 生产接线挂在管理前缀下：同一 Handler 必须只认配置的前缀。
func TestHandlerServesConfiguredPathPrefix(t *testing.T) {
	testRig := newRig(t, []accountcore.AccountRef{accountA},
		respondWith(sseResponse(okStream()), nil), func(dependencies *Dependencies) {
			dependencies.PathPrefix = ManagementCollectionPath
		})
	internal := testRig.postPath(t, ManagementCollectionPath+"s-1/commands", submitBody, nil)
	if internal.Code != http.StatusOK {
		t.Fatalf("管理路径状态码 = %d, body = %s", internal.Code, internal.Body.String())
	}
	browser := testRig.postPath(t, commandPath, submitBody, nil)
	if browser.Code != http.StatusNotFound {
		t.Fatalf("浏览器路径状态码 = %d, want 404", browser.Code)
	}
}

// 历史消息由 Node 随指令带来；顺序与内容必须原样交给上游。
func TestHandleTurnForwardsHistoryMessages(t *testing.T) {
	body := `{"commandId":"c-1","type":"turn.submit","payload":{"content":"第二轮","model":"gpt-test","messages":[{"role":"system","content":"你是助手"},{"role":"user","content":"第一轮"},{"role":"assistant","content":"第一次回答"},{"role":"user","content":"第二轮"}]}}`
	testRig := newRig(t, []accountcore.AccountRef{accountA}, respondWith(sseResponse(okStream()), nil), nil)
	recorder := testRig.post(t, body, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	_, bodies := testRig.client.sent()
	var payload struct {
		Messages []map[string]string `json:"messages"`
	}
	if err := json.Unmarshal([]byte(bodies[0]), &payload); err != nil {
		t.Fatalf("上游请求体解码失败: %v", err)
	}
	want := [][2]string{
		{"system", "你是助手"},
		{"user", "第一轮"},
		{"assistant", "第一次回答"},
		{"user", "第二轮"},
	}
	if len(payload.Messages) != len(want) {
		t.Fatalf("messages = %+v", payload.Messages)
	}
	for index, entry := range want {
		if payload.Messages[index]["role"] != entry[0] || payload.Messages[index]["content"] != entry[1] {
			t.Fatalf("messages[%d] = %+v", index, payload.Messages[index])
		}
	}
}

// 历史消息的非法形态必须报错：静默丢一条历史等于让模型看到错误上下文。
func TestDecodeTurnSubmitRejectsInvalidMessages(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{
			name: "不是数组",
			body: `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","messages":{}}}`,
		},
		{
			name: "角色不受支持",
			body: `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","messages":[{"role":"tool","content":"x"},{"role":"user","content":"hi"}]}}`,
		},
		{
			name: "正文为空",
			body: `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","messages":[{"role":"user","content":"   "}]}}`,
		},
		{
			name: "最后一条不是用户消息",
			body: `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}}`,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, routeErr := decodeTurnSubmit([]byte(testCase.body))
			if routeErr == nil || routeErr.Code != "chat_turn_messages_invalid" {
				t.Fatalf("routeErr = %+v", routeErr)
			}
		})
	}
}

type denyAuthorizer struct{}

func (denyAuthorizer) Authorized(*http.Request) bool { return false }
