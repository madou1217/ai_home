package kimirelay

import (
	"encoding/json"
	"net/http"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const testAccountRef = "acct_33b6d72c47665c11d5ef"

func nativeCredential(t *testing.T, payload []byte) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "user-1")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

func decode(t *testing.T, body []byte) map[string]json.RawMessage {
	t.Helper()
	fields, ok := relaycore.DecodeRawObject(body)
	if !ok {
		t.Fatalf("结果不是 JSON 对象: %s", body)
	}
	return fields
}

// TestEndpointsSplitByCredentialKind 守端点分流（OAuth 走 coding，API Key 走公开 API）。
func TestEndpointsSplitByCredentialKind(t *testing.T) {
	oauthEndpoint, _ := NewProvider(ProviderOptions{IsAPIKey: false}).Endpoint()
	if oauthEndpoint != KimiCodeBaseURL+ChatCompletionsPath {
		t.Fatalf("OAuth 账号必须走 coding 端点，实际 %q", oauthEndpoint)
	}
	apiKeyEndpoint, _ := NewProvider(ProviderOptions{IsAPIKey: true}).Endpoint()
	if apiKeyEndpoint != KimiAPIBaseURL+ChatCompletionsPath {
		t.Fatalf("API Key 账号必须走公开 API 端点，实际 %q", apiKeyEndpoint)
	}
}

// TestVersionFallsBackWhenEmpty 守版本兜底。
func TestVersionFallsBackWhenEmpty(t *testing.T) {
	provider := NewProvider(ProviderOptions{})
	request, _ := http.NewRequest(http.MethodPost, "https://api.kimi.com", nil)
	provider.DecorateUpstream(request, "token")
	if got := request.Header.Get("X-Msh-Version"); got != FallbackVersion {
		t.Fatalf("空版本必须用兜底值，实际 %q", got)
	}
}

// TestDeviceHeadersUseAccountStrategy 守设备头来自账号策略（差异 1）。
func TestDeviceHeadersUseAccountStrategy(t *testing.T) {
	provider := NewProvider(ProviderOptions{
		Version:    "2.2.0",
		AccountRef: testAccountRef,
		Profile:    kimiidentity.DefaultProfile(),
		Host:       kimiidentity.HostFacts{HostName: "secret-host", OSVersion: "25.1.0"},
	})
	request, _ := http.NewRequest(http.MethodPost, "https://api.kimi.com", nil)
	provider.DecorateUpstream(request, "token")

	if got := request.Header.Get("User-Agent"); got != "kimi-code-cli/2.2.0" {
		t.Fatalf("UA 错误：%q", got)
	}
	if got := request.Header.Get("X-Msh-Platform"); got != "kimi_code_cli" {
		t.Fatalf("platform 错误：%q", got)
	}
	want := kimiidentity.DeriveStableDeviceID(testAccountRef, "")
	if got := request.Header.Get("X-Msh-Device-Id"); got != want {
		t.Fatalf("设备 id 必须由账号派生：got %q want %q", got, want)
	}
	if got := request.Header.Get("X-Msh-Device-Name"); got == "secret-host" {
		t.Fatal("stable-derived 下不得暴露宿主主机名")
	}
	if got := request.Header.Get("X-Msh-Os-Version"); got == "25.1.0" {
		t.Fatal("stable-derived 下不得暴露宿主系统版本")
	}
}

// TestCredentialDeviceIDWinsInHeaders 守凭据声明的 device id 优先。
func TestCredentialDeviceIDWinsInHeaders(t *testing.T) {
	provider := NewProvider(ProviderOptions{
		AccountRef:         testAccountRef,
		Profile:            kimiidentity.DefaultProfile(),
		CredentialDeviceID: "official-device-id",
	})
	request, _ := http.NewRequest(http.MethodPost, "https://api.kimi.com", nil)
	provider.DecorateUpstream(request, "token")
	if got := request.Header.Get("X-Msh-Device-Id"); got != "official-device-id" {
		t.Fatalf("凭据声明的 device id 必须优先，实际 %q", got)
	}
}

// TestAdaptTranslatesEffortToThinking 守 reasoning_effort → thinking。
func TestAdaptTranslatesEffortToThinking(t *testing.T) {
	body := []byte(`{"model":"k3","reasoning_effort":"high","messages":[]}`)
	adapted, err := AdaptChatRequest(body)
	if err != nil {
		t.Fatalf("翻译失败: %v", err)
	}
	fields := decode(t, adapted)
	if _, still := fields["reasoning_effort"]; still {
		t.Fatal("reasoning_effort 必须被翻译掉（上游只认 thinking）")
	}
	thinking, ok := relaycore.DecodeRawObject(fields["thinking"])
	if !ok {
		t.Fatalf("必须产出 thinking 对象：%s", adapted)
	}
	if kind, _ := relaycore.RawString(thinking["type"]); kind != "enabled" {
		t.Fatalf("thinking.type 错误：%q", kind)
	}
	if effort, _ := relaycore.RawString(thinking["effort"]); effort != "high" {
		t.Fatalf("thinking.effort 错误：%q", effort)
	}
}

// TestAdaptMapsNoneToDisabled 守 none/off → disabled。
func TestAdaptMapsNoneToDisabled(t *testing.T) {
	for _, effort := range []string{"none", "off"} {
		adapted, _ := AdaptChatRequest([]byte(`{"reasoning_effort":"` + effort + `"}`))
		fields := decode(t, adapted)
		thinking, _ := relaycore.DecodeRawObject(fields["thinking"])
		if kind, _ := relaycore.RawString(thinking["type"]); kind != "disabled" {
			t.Fatalf("%s 必须翻译成 disabled，实际 %q", effort, kind)
		}
	}
}

// TestAdaptKeepsNativeThinking 守「原生字段优先」。
func TestAdaptKeepsNativeThinking(t *testing.T) {
	body := []byte(`{"reasoning_effort":"high","thinking":{"type":"disabled"}}`)
	adapted, _ := AdaptChatRequest(body)
	fields := decode(t, adapted)
	thinking, _ := relaycore.DecodeRawObject(fields["thinking"])
	if kind, _ := relaycore.RawString(thinking["type"]); kind != "disabled" {
		t.Fatalf("已带 thinking 时必须原样保留，实际 %q", kind)
	}
}

// TestAdaptTranslatesMaxTokens 守 max_tokens → max_completion_tokens。
func TestAdaptTranslatesMaxTokens(t *testing.T) {
	adapted, _ := AdaptChatRequest([]byte(`{"max_tokens":4096}`))
	fields := decode(t, adapted)
	if _, still := fields["max_tokens"]; still {
		t.Fatal("max_tokens 必须被翻译掉")
	}
	if budget, ok := relaycore.RawInt64(fields["max_completion_tokens"]); !ok || budget != 4096 {
		t.Fatalf("max_completion_tokens 错误：%s", adapted)
	}
}

// TestAdaptKeepsNativeBudget 守原生预算优先。
func TestAdaptKeepsNativeBudget(t *testing.T) {
	adapted, _ := AdaptChatRequest([]byte(`{"max_tokens":4096,"max_completion_tokens":8192}`))
	fields := decode(t, adapted)
	if budget, _ := relaycore.RawInt64(fields["max_completion_tokens"]); budget != 8192 {
		t.Fatalf("原生预算必须优先，实际 %d", budget)
	}
}

// TestAdaptAddsStreamUsage 守流式补 include_usage。
func TestAdaptAddsStreamUsage(t *testing.T) {
	adapted, _ := AdaptChatRequest([]byte(`{"stream":true}`))
	fields := decode(t, adapted)
	options, ok := relaycore.DecodeRawObject(fields["stream_options"])
	if !ok {
		t.Fatalf("流式请求必须补 stream_options：%s", adapted)
	}
	if include, ok := relaycore.RawBool(options["include_usage"]); !ok || !include {
		t.Fatal("必须补 include_usage: true")
	}
}

// TestAdaptKeepsExistingStreamUsage 守已有 stream_options 时不重复改。
func TestAdaptKeepsExistingStreamUsage(t *testing.T) {
	body := []byte(`{"stream":true,"stream_options":{"include_usage":false}}`)
	adapted, _ := AdaptChatRequest(body)
	fields := decode(t, adapted)
	options, _ := relaycore.DecodeRawObject(fields["stream_options"])
	if include, _ := relaycore.RawBool(options["include_usage"]); include {
		t.Fatal("已显式声明时不得改写")
	}
}

// TestAdaptLeavesCleanRequestUntouched 守「不需要翻译时逐字节不变」。
func TestAdaptLeavesCleanRequestUntouched(t *testing.T) {
	body := []byte(`{"model":"k3","messages":[{"role":"user","content":"hi"}]}`)
	adapted, _ := AdaptChatRequest(body)
	if string(adapted) != string(body) {
		t.Fatalf("无需翻译时必须逐字节返回，实际 %s", adapted)
	}
}

// TestAdaptToleratesNonObject 守非对象输入不炸。
func TestAdaptToleratesNonObject(t *testing.T) {
	for _, body := range []string{``, `[]`, `"text"`, `not json`} {
		adapted, err := AdaptChatRequest([]byte(body))
		if err != nil {
			t.Fatalf("非对象输入不该报错：%v", err)
		}
		if string(adapted) != body {
			t.Fatalf("非对象输入必须原样返回：%q", adapted)
		}
	}
}

// TestAccessTokenReadsCredentials 守凭据取法。
func TestAccessTokenReadsCredentials(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"credentials": map[string]any{"access_token": "kimi-token"},
	})
	provider := NewProvider(ProviderOptions{})
	got, err := provider.AccessToken(nativeCredential(t, payload))
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != "kimi-token" {
		t.Fatalf("令牌错误：%q", got)
	}
}

// TestAccessTokenRejectsUnknownShape 守不猜字段。
func TestAccessTokenRejectsUnknownShape(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"unrelated": "value"})
	provider := NewProvider(ProviderOptions{})
	if _, err := provider.AccessToken(nativeCredential(t, payload)); err == nil {
		t.Fatal("认不出的形态必须拒绝")
	}
	if _, err := provider.AccessToken(nil); err == nil {
		t.Fatal("nil 凭据必须拒绝")
	}
}

// TestResolveAcceptsOwnIDOnly 守单 Provider 通道语义。
func TestResolveAcceptsOwnIDOnly(t *testing.T) {
	provider := NewProvider(ProviderOptions{})
	if _, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "kimi"}); !ok {
		t.Fatal("kimi 必须解析成功")
	}
	if _, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "grok"}); ok {
		t.Fatal("别的 Provider 不得解析成功")
	}
}

// TestProviderSatisfiesRelaycoreContract 守接口实现。
func TestProviderSatisfiesRelaycoreContract(t *testing.T) {
	var _ relaycore.Provider = NewProvider(ProviderOptions{})
}
