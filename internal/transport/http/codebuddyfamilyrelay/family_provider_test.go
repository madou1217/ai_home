package codebuddyfamilyrelay

import (
	"errors"
	"testing"
)

func TestFamilyProviderTable(t *testing.T) {
	cases := []struct {
		provider string
		base     string
	}{
		{"codebuddy", "https://www.codebuddy.ai"},
		{"workbuddy", "https://www.workbuddy.ai"},
		{"codebuddycn", "https://copilot.tencent.com"},
		{"workbuddycn", "https://copilot.tencent.com"},
	}
	for _, testCase := range cases {
		if !IsFamilyProvider(testCase.provider) {
			t.Fatalf("%s 应属于家族", testCase.provider)
		}
		base, ok := InferenceBaseURL(testCase.provider)
		if !ok || base != testCase.base {
			t.Fatalf("%s 的站点根 = %q，期望 %q", testCase.provider, base, testCase.base)
		}
		endpoint, ok := InferenceEndpoint(testCase.provider)
		if !ok || endpoint != testCase.base+ChatCompletionsPath {
			t.Fatalf("%s 的上游 URL = %q，期望 %q", testCase.provider, endpoint, testCase.base+ChatCompletionsPath)
		}
	}
	// 国内站两支共用同一个网关（发行版级 endpoint），国际站各用自己域名。
	cnBase, _ := InferenceBaseURL("codebuddycn")
	workCNBase, _ := InferenceBaseURL("workbuddycn")
	if cnBase != workCNBase {
		t.Fatal("国内站两支必须共用同一个推理网关")
	}
}

func TestFamilyProviderRejectsOthers(t *testing.T) {
	for _, provider := range []string{"", "codex", "claude", "agy", "gemini", "opencode", "codebuddy.ai", "workbuddyx"} {
		if IsFamilyProvider(provider) {
			t.Fatalf("%q 不应被当作家族成员", provider)
		}
		if _, ok := InferenceEndpoint(provider); ok {
			t.Fatalf("%q 不应有家族上游 URL", provider)
		}
	}
	// 大小写与空白归一后仍要认出来（CLI 输入常见形态）。
	if !IsFamilyProvider("  CodeBuddyCN ") {
		t.Fatal("大小写与空白归一后应识别为家族成员")
	}
}

func TestAccessTokenFromPayload(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		token   string
	}{
		{"nested accessToken", `{"credentials":{"auth":{"accessToken":"tok-1"}}}`, "tok-1"},
		{"snake case fallback", `{"credentials":{"auth":{"access_token":" tok-2 "}}}`, "tok-2"},
		{"extra fields ignored", `{"credentials":{"auth":{"accessToken":"tok-3","refreshToken":"r"}},"account":{"uid":"u"}}`, "tok-3"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			token, err := accessTokenFromPayload([]byte(testCase.payload))
			if err != nil || token != testCase.token {
				t.Fatalf("token = %q (err=%v)，期望 %q", token, err, testCase.token)
			}
		})
	}
	for _, payload := range []string{
		``,
		`not json`,
		`{"credentials":{}}`,
		`{"credentials":{"auth":{}}}`,
		`{"credentials":{"auth":{"accessToken":""}}}`,
		`{"credentials":{"auth":{"accessToken":42}}}`,
		`{"auth":{"accessToken":"tok"}}`,
	} {
		if _, err := accessTokenFromPayload([]byte(payload)); !errors.Is(err, ErrUnsupportedCredential) {
			t.Fatalf("payload %q 应返回 ErrUnsupportedCredential，实际 %v", payload, err)
		}
	}
	// 非原生凭据（或 nil）一律不可透传：交回 Canonical。
	if _, err := AccessTokenFromCredential(nil); !errors.Is(err, ErrUnsupportedCredential) {
		t.Fatalf("nil 凭据应返回 ErrUnsupportedCredential，实际 %v", err)
	}
}
