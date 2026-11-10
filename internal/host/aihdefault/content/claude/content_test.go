package claude

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("读取 fixture %s 失败: %v", name, err)
	}
	return data
}

func TestGatewayProfileEnv(t *testing.T) {
	tests := []struct {
		name    string
		config  ServerConfig
		apiKey  string
		rootURL string
		baseURL string
	}{
		{
			name:    "默认地址与 dummy 密钥",
			config:  ServerConfig{},
			apiKey:  DefaultClientKey,
			rootURL: "http://127.0.0.1:9527",
			baseURL: "http://127.0.0.1:9527/v1",
		},
		{
			name:    "apiKey 优先于 clientKey 并去空白",
			config:  ServerConfig{APIKey: "  key-api  ", ClientKey: "key-client"},
			apiKey:  "key-api",
			rootURL: "http://127.0.0.1:9527",
			baseURL: "http://127.0.0.1:9527/v1",
		},
		{
			name:    "只有 clientKey 时回落到它",
			config:  ServerConfig{ClientKey: "key-client"},
			apiKey:  "key-client",
			rootURL: "http://127.0.0.1:9527",
			baseURL: "http://127.0.0.1:9527/v1",
		},
		{
			name:    "自定义地址与端口",
			config:  ServerConfig{Host: "10.0.0.5", Port: 8080, APIKey: "k"},
			apiKey:  "k",
			rootURL: "http://10.0.0.5:8080",
			baseURL: "http://10.0.0.5:8080/v1",
		},
		{
			name:    "0.0.0.0 归一成回环地址",
			config:  ServerConfig{Host: "0.0.0.0", Port: 9527},
			apiKey:  DefaultClientKey,
			rootURL: "http://127.0.0.1:9527",
			baseURL: "http://127.0.0.1:9527/v1",
		},
		{
			name:    "IPv6 地址加方括号",
			config:  ServerConfig{Host: "::1", Port: 9527},
			apiKey:  DefaultClientKey,
			rootURL: "http://[::1]:9527",
			baseURL: "http://[::1]:9527/v1",
		},
		{
			name:    "非法端口回落默认端口",
			config:  ServerConfig{Port: 70000},
			apiKey:  DefaultClientKey,
			rootURL: "http://127.0.0.1:9527",
			baseURL: "http://127.0.0.1:9527/v1",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := GatewayProfileEnv(test.config)
			if env[APIKeyEnv] != test.apiKey {
				t.Fatalf("%s = %q，期望 %q", APIKeyEnv, env[APIKeyEnv], test.apiKey)
			}
			if env[BaseURLEnv] != test.rootURL {
				t.Fatalf("%s = %q，期望 %q", BaseURLEnv, env[BaseURLEnv], test.rootURL)
			}
			if test.config.BaseURL() != test.baseURL {
				t.Fatalf("BaseURL() = %q，期望 %q", test.config.BaseURL(), test.baseURL)
			}
			if len(env) != 2 {
				t.Fatalf("网关档位只应有密钥与地址，实际 %d 项: %v", len(env), env)
			}
		})
	}
}

func TestNormalizeBaseURL(t *testing.T) {
	tests := []struct{ input, want string }{
		{"http://127.0.0.1:9527", "http://127.0.0.1:9527"},
		{"http://127.0.0.1:9527/v1", "http://127.0.0.1:9527"},
		{"https://relay.example.com/v1/", "https://relay.example.com"},
		{"https://relay.example.com/V1", "https://relay.example.com"},
		{"https://relay.example.com/anthropic", "https://relay.example.com/anthropic"},
		{"https://relay.example.com/apps/anthropic", "https://relay.example.com/apps/anthropic"},
		{"  http://127.0.0.1:9527/v1//  ", "http://127.0.0.1:9527"},
		{"", ""},
	}
	for _, test := range tests {
		if got := NormalizeBaseURL(test.input); got != test.want {
			t.Fatalf("NormalizeBaseURL(%q) = %q，期望 %q", test.input, got, test.want)
		}
	}
}

func TestAccountRelayEnvRejectsInvalidAccountRef(t *testing.T) {
	gateway := GatewayProfileEnv(ServerConfig{APIKey: "k"})
	for _, ref := range []string{
		"",
		"acct_",
		"acct_0123456789abcdef012",
		"acct_0123456789abcdef01234",
		"acct_0123456789ABCDEF0123",
		"acct-0123456789abcdef0123",
	} {
		if _, err := AccountRelayEnv(gateway, ref); !errors.Is(err, ErrInvalidAccountRef) {
			t.Fatalf("AccountRelayEnv(%q) 应返回 ErrInvalidAccountRef，实际 %v", ref, err)
		}
	}
}

func TestAccountRelayEnvMergesHeaders(t *testing.T) {
	gateway := Env{
		APIKeyEnv:        "k",
		BaseURLEnv:       "http://127.0.0.1:9527",
		CustomHeadersEnv: "x-user-header: keep-me\nx-account-ref: acct_0123456789abcdef0123",
	}
	relay, err := AccountRelayEnv(gateway, " acct_11111111111111111111 ")
	if err != nil {
		t.Fatalf("AccountRelayEnv 失败: %v", err)
	}
	want := "x-user-header: keep-me\nx-account-ref: acct_11111111111111111111"
	if relay[CustomHeadersEnv] != want {
		t.Fatalf("%s = %q，期望 %q", CustomHeadersEnv, relay[CustomHeadersEnv], want)
	}
	if relay[APIKeyEnv] != "k" || relay[BaseURLEnv] != "http://127.0.0.1:9527" {
		t.Fatalf("网关 env 应原样保留，实际 %v", relay)
	}
	if _, mutated := gateway[CustomHeadersEnv]; !mutated || gateway[CustomHeadersEnv] != "x-user-header: keep-me\nx-account-ref: acct_0123456789abcdef0123" {
		t.Fatalf("入参不应被修改，实际 %q", gateway[CustomHeadersEnv])
	}
}

func TestDefaultLandingFixtures(t *testing.T) {
	current := readFixture(t, "host_settings.json")
	config := ServerConfig{APIKey: "gw-client-key"}
	tests := []struct {
		name       string
		accountRef string
		golden     string
	}{
		{name: "不钉账号的 AIH Server 默认", golden: "expected_landing_gateway.json"},
		{
			name:       "钉选账号时替换旧钉选行",
			accountRef: "acct_11111111111111111111",
			golden:     "expected_landing_pinned.json",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := DefaultLandingPayload(config, test.accountRef, current)
			if err != nil {
				t.Fatalf("DefaultLandingPayload 失败: %v", err)
			}
			want := readFixture(t, test.golden)
			if !bytes.Equal(got, want) {
				t.Fatalf("落点内容与 golden 不一致\n实际:\n%s\n期望:\n%s", got, want)
			}
			wantPinLines := 0
			if test.accountRef != "" {
				wantPinLines = 1
			}
			if count := strings.Count(string(got), PinnedAccountHeader+":"); count != wantPinLines {
				t.Fatalf("钉选行数量 = %d，期望 %d，实际内容:\n%s", count, wantPinLines, got)
			}
			// 幂等：同一份内容再算一次必须字节相等，否则受管内容哈希会一直抖动。
			again, err := DefaultLandingPayload(config, test.accountRef, got)
			if err != nil {
				t.Fatalf("二次落点失败: %v", err)
			}
			if !bytes.Equal(again, got) {
				t.Fatalf("落点不幂等\n第一次:\n%s\n第二次:\n%s", got, again)
			}
		})
	}
}

func TestBuildSettingsContentValidation(t *testing.T) {
	credential := Env{TokenEnv: "k", BaseURLEnv: "http://127.0.0.1:9527"}

	t.Run("空内容只写托管 env", func(t *testing.T) {
		got, err := BuildSettingsContent(nil, credential)
		if err != nil {
			t.Fatalf("BuildSettingsContent 失败: %v", err)
		}
		want := "{\n  \"env\": {\n    \"ANTHROPIC_AUTH_TOKEN\": \"k\",\n    \"ANTHROPIC_BASE_URL\": \"http://127.0.0.1:9527\"\n  }\n}\n"
		if string(got) != want {
			t.Fatalf("实际:\n%s\n期望:\n%s", got, want)
		}
		if json.Valid(got) != true {
			t.Fatalf("输出不是合法 JSON: %s", got)
		}
	})

	t.Run("删除旧凭据且不动其它 env", func(t *testing.T) {
		current := []byte("{\"env\":{\"ANTHROPIC_API_KEY\":\"old\",\"KEEP\":\"1\"},\"model\":\"opus\"}")
		got, err := BuildSettingsContent(current, credential)
		if err != nil {
			t.Fatalf("BuildSettingsContent 失败: %v", err)
		}
		if bytes.Contains(got, []byte("old")) {
			t.Fatalf("旧 ANTHROPIC_API_KEY 应被清掉: %s", got)
		}
		for _, fragment := range []string{"\"KEEP\": \"1\"", "\"model\": \"opus\""} {
			if !bytes.Contains(got, []byte(fragment)) {
				t.Fatalf("应保留 %s，实际: %s", fragment, got)
			}
		}
	})

	t.Run("env 为 null 视为空对象", func(t *testing.T) {
		got, err := BuildSettingsContent([]byte("{\"env\":null}"), credential)
		if err != nil {
			t.Fatalf("BuildSettingsContent 失败: %v", err)
		}
		if !bytes.Contains(got, []byte("\"ANTHROPIC_AUTH_TOKEN\": \"k\"")) {
			t.Fatalf("应写入托管凭据，实际: %s", got)
		}
	})

	t.Run("不转义 HTML", func(t *testing.T) {
		got, err := BuildSettingsContent(nil, Env{TokenEnv: "a<b", BaseURLEnv: "http://127.0.0.1:9527"})
		if err != nil {
			t.Fatalf("BuildSettingsContent 失败: %v", err)
		}
		if !bytes.Contains(got, []byte("\"a<b\"")) {
			t.Fatalf("不应转义尖括号，实际: %s", got)
		}
	})

	for _, test := range []struct {
		name    string
		current string
	}{
		{name: "顶层是数组", current: "[]"},
		{name: "顶层是标量", current: "42"},
		{name: "env 是数组", current: "{\"env\":[]}"},
		{name: "非法 JSON", current: "{"},
		{name: "带注释", current: "{\"env\":{}} // note"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := BuildSettingsContent([]byte(test.current), credential); !errors.Is(err, ErrInvalidSettings) {
				t.Fatalf("应返回 ErrInvalidSettings，实际 %v", err)
			}
		})
	}
}

func TestDefaultLandingPayloadRejectsInvalidAccountRef(t *testing.T) {
	if _, err := DefaultLandingPayload(ServerConfig{}, "acct_short", nil); !errors.Is(err, ErrInvalidAccountRef) {
		t.Fatalf("应返回 ErrInvalidAccountRef，实际 %v", err)
	}
}

func TestValidAccountRef(t *testing.T) {
	if !ValidAccountRef(" acct_0123456789abcdef0123 ") {
		t.Fatal("合法引用应带空白也通过")
	}
	if ValidAccountRef("acct_0123456789abcdef012g") {
		t.Fatal("非十六进制字符应判非法")
	}
}
