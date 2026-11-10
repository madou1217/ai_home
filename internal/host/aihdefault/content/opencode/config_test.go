package opencode

import (
	"errors"
	"strings"
	"testing"
)

func testGateway() Gateway {
	return Gateway{
		Server: ServerConfig{APIKey: "test-key"},
		Models: []string{"claude-sonnet-4-6", "claude-opus-4-5", "gpt-5"},
	}
}

// TestBuildGatewayConfigFromEmptyDocument 空文件按缺省结构生成，model 落在 provider 之前。
func TestBuildGatewayConfigFromEmptyDocument(t *testing.T) {
	content, err := BuildGatewayConfig("", testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	want := `{
  "$schema": "https://opencode.ai/config.json",
  "model": "aih/claude-sonnet-4-6",
  "provider": {
    "aih": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AI Home Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:9527/v1",
        "apiKey": "test-key"
      },
      "models": {
        "claude-opus-4-5": {
          "name": "claude-opus-4-5 (AIH)"
        },
        "claude-sonnet-4-6": {
          "name": "claude-sonnet-4-6 (AIH)"
        },
        "gpt-5": {
          "name": "gpt-5 (AIH)"
        }
      }
    }
  }
}
`
	if content != want {
		t.Fatalf("content =\n%swant\n%s", content, want)
	}
}

// TestBuildGatewayConfigKeepsUserKeysAndComments 用户键、注释、缩进必须原样保留。
func TestBuildGatewayConfigKeepsUserKeysAndComments(t *testing.T) {
	rawConfig := `{
  // 用户自己的主题，不要动
  "theme": "dark",
  "model": "openai/gpt-5",
  "autoupdate": true,
  "provider": {
    "openai": {
      "options": { "apiKey": "sk-user" }
    }
  }
}
`
	content, err := BuildGatewayConfig(rawConfig, testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	for _, fragment := range []string{
		"// 用户自己的主题，不要动",
		`"theme": "dark"`,
		`"autoupdate": true`,
		`"openai": {`,
		`"apiKey": "sk-user"`,
		`"model": "aih/claude-sonnet-4-6"`,
	} {
		if !strings.Contains(content, fragment) {
			t.Fatalf("content missing %q\n%s", fragment, content)
		}
	}
	if strings.Contains(content, `"model": "openai/gpt-5"`) {
		t.Fatalf("stale model kept:\n%s", content)
	}
	root := mustDecode(t, content)
	if _, found := mustObject(t, root, "provider", "aih", "models").get("claude-opus-4-5"); !found {
		t.Fatalf("models block missing:\n%s", content)
	}
	mustPath(t, root, "provider", "openai", "options", "apiKey")
}

// TestBuildGatewayConfigIsIdempotent 同一份输入重复落点必须产出同一份字节，否则归属哈希天天变。
func TestBuildGatewayConfigIsIdempotent(t *testing.T) {
	rawConfig := `{
  // 保留注释
  "theme": "dark"
}
`
	first, err := BuildGatewayConfig(rawConfig, testGateway())
	if err != nil {
		t.Fatalf("first BuildGatewayConfig() error = %v", err)
	}
	second, err := BuildGatewayConfig(first, testGateway())
	if err != nil {
		t.Fatalf("second BuildGatewayConfig() error = %v", err)
	}
	if second != first {
		t.Fatalf("not idempotent:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

// TestBuildGatewayConfigKeepsSchemaAndTrailingComma 已有 $schema 不覆盖；尾随逗号风格沿用。
func TestBuildGatewayConfigKeepsSchemaAndTrailingComma(t *testing.T) {
	rawConfig := `{
  "$schema": "https://example.com/custom.json",
  "theme": "dark",
}
`
	content, err := BuildGatewayConfig(rawConfig, testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if !strings.Contains(content, `"$schema": "https://example.com/custom.json"`) {
		t.Fatalf("schema overwritten:\n%s", content)
	}
	if strings.Contains(content, "https://opencode.ai/config.json") {
		t.Fatalf("default schema injected:\n%s", content)
	}
	if !strings.Contains(content, `"theme": "dark",`) {
		t.Fatalf("trailing comma style dropped:\n%s", content)
	}
	mustDecode(t, content)
}

// TestBuildGatewayConfigKeepsEmptyObjectComments 空对象里只有注释时，注释要留在文件里。
func TestBuildGatewayConfigKeepsEmptyObjectComments(t *testing.T) {
	content, err := BuildGatewayConfig("{\n  // 先留个空文件\n}\n", testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if !strings.Contains(content, "// 先留个空文件") {
		t.Fatalf("comment dropped:\n%s", content)
	}
	mustPath(t, mustDecode(t, content), "provider", "aih", "options", "baseURL")
}

// TestBuildGatewayConfigRejectsForeignProvider aih 这个名字被别人占用时报冲突，不覆盖。
func TestBuildGatewayConfigRejectsForeignProvider(t *testing.T) {
	rawConfig := `{"provider": {"aih": {"name": "Someone Else"}}}`
	_, err := BuildGatewayConfig(rawConfig, testGateway())
	if !errors.Is(err, ErrProviderConflict) {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if !strings.Contains(err.Error(), "Someone Else") {
		t.Fatalf("error lacks offending name: %v", err)
	}
}

// TestBuildGatewayConfigRejectsInvalidDocuments 语法错、根不是对象、provider 不是对象都失败关闭。
func TestBuildGatewayConfigRejectsInvalidDocuments(t *testing.T) {
	cases := map[string]string{
		"syntax":            `{"theme": }`,
		"array root":        `[]`,
		"provider scalar":   `{"provider": "aih"}`,
		"unclosed comment":  `{ /* nope`,
		"unterminated text": `{"a": 1`,
	}
	for name, rawConfig := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := BuildGatewayConfig(rawConfig, testGateway()); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("BuildGatewayConfig() error = %v", err)
			}
			if _, err := BuildGatewayJSON(rawConfig, testGateway()); !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("BuildGatewayJSON() error = %v", err)
			}
		})
	}
}

// TestBuildGatewayConfigRequiresModels 没有探测到模型时不能猜一个写死型号。
func TestBuildGatewayConfigRequiresModels(t *testing.T) {
	gateway := Gateway{Server: ServerConfig{APIKey: "test-key"}}
	if _, err := BuildGatewayConfig("{}", gateway); !errors.Is(err, ErrModelsUnavailable) {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if got := DefaultModel(nil); got != "" {
		t.Fatalf("DefaultModel(nil) = %q", got)
	}
}

// TestBuildGatewayConfigDedupesModels 探测结果里的空白与重复不能进入配置，否则文件每次都不一样。
func TestBuildGatewayConfigDedupesModels(t *testing.T) {
	content, err := BuildGatewayConfig("{}", Gateway{
		Server: ServerConfig{APIKey: "test-key"},
		Models: []string{" gpt-5", "gpt-5", "", "claude-haiku-4-5 "},
	})
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if strings.Count(content, `"gpt-5"`) != 1 {
		t.Fatalf("duplicate model kept:\n%s", content)
	}
	if strings.Contains(content, `" gpt-5"`) {
		t.Fatalf("untrimmed model kept:\n%s", content)
	}
}

// TestBuildGatewayJSONCanonicalOutput 标准 JSON 输出保留用户键，但不保留注释。
func TestBuildGatewayJSONCanonicalOutput(t *testing.T) {
	rawConfig := `{
  // 注释在重排输出里会被丢掉
  "theme": "dark",
  "model": "openai/gpt-5",
  "provider": {"openai": {"options": {"apiKey": "sk-user"}}}
}
`
	content, err := BuildGatewayJSON(rawConfig, testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayJSON() error = %v", err)
	}
	if strings.Contains(content, "注释") {
		t.Fatalf("comment kept in canonical output:\n%s", content)
	}
	root := mustDecode(t, content)
	if got := mustPath(t, root, "theme"); got != "dark" {
		t.Fatalf("theme = %v", got)
	}
	if got := mustPath(t, root, "model"); got != "aih/claude-sonnet-4-6" {
		t.Fatalf("model = %v", got)
	}
	if got := mustPath(t, root, "provider", "openai", "options", "apiKey"); got != "sk-user" {
		t.Fatalf("user provider = %v", got)
	}
	if got := mustPath(t, root, "$schema"); got != SchemaURL {
		t.Fatalf("$schema = %v", got)
	}
	if root.keys[0] != "$schema" {
		t.Fatalf("$schema not first: %v", root.keys)
	}
	if _, err := BuildGatewayJSON(content, testGateway()); err != nil {
		t.Fatalf("canonical output not rebuildable: %v", err)
	}
}

// TestBuildGatewayContentAdapter 适配器可直接赋给 aihdefault.BuildContent。
func TestBuildGatewayContentAdapter(t *testing.T) {
	build := BuildGatewayContent(testGateway())
	fromNothing, err := build("", false)
	if err != nil {
		t.Fatalf("build() error = %v", err)
	}
	if fromNothing != mustBuild(t, "") {
		t.Fatalf("adapter diverged from BuildGatewayConfig")
	}
	withComment, err := build(`{"theme": "dark", // 注释
}`, true)
	if err != nil {
		t.Fatalf("build(existing) error = %v", err)
	}
	if !strings.Contains(withComment, "// 注释") {
		t.Fatalf("comment dropped:\n%s", withComment)
	}
}

// TestBaseURL 网关地址的归一：缺省主机、非法端口、IPv6 方括号、ClientKey 兜底。
func TestBaseURL(t *testing.T) {
	cases := []struct {
		name   string
		server ServerConfig
		want   string
	}{
		{"defaults", ServerConfig{}, "http://127.0.0.1:9527/v1"},
		{"wildcard host", ServerConfig{Host: "0.0.0.0"}, "http://127.0.0.1:9527/v1"},
		{"bad port", ServerConfig{Port: 70000}, "http://127.0.0.1:9527/v1"},
		{"custom port", ServerConfig{Port: 8123}, "http://127.0.0.1:8123/v1"},
		{"ipv6", ServerConfig{Host: "::1"}, "http://[::1]:9527/v1"},
		{"ipv6 bracketed", ServerConfig{Host: "[::1]"}, "http://[::1]:9527/v1"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := BaseURL(testCase.server); got != testCase.want {
				t.Fatalf("BaseURL(%+v) = %q, want %q", testCase.server, got, testCase.want)
			}
		})
	}
	content, err := BuildGatewayConfig("{}", Gateway{
		Server: ServerConfig{ClientKey: "client-key"},
		Models: []string{"gpt-5"},
	})
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if !strings.Contains(content, `"apiKey": "client-key"`) {
		t.Fatalf("clientKey fallback missing:\n%s", content)
	}
	content, err = BuildGatewayConfig("{}", Gateway{Models: []string{"gpt-5"}})
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	if !strings.Contains(content, `"apiKey": "dummy"`) {
		t.Fatalf("dummy api key missing:\n%s", content)
	}
}

// TestDefaultModel 家族优先 + 版本号最大；8 位日期快照不能压过真实版本段。
func TestDefaultModel(t *testing.T) {
	cases := []struct {
		name   string
		models []string
		want   string
	}{
		{"sonnet over opus", []string{"claude-opus-4-9", "claude-sonnet-4-5"}, "claude-sonnet-4-5"},
		{"newest wins", []string{"claude-sonnet-3-7", "claude-sonnet-4-6"}, "claude-sonnet-4-6"},
		{"date snapshot is tiebreak", []string{"claude-sonnet-4-20250514", "claude-sonnet-4-6"}, "claude-sonnet-4-6"},
		{"haiku fallback", []string{"claude-opus-4-5", "claude-haiku-4-5"}, "claude-opus-4-5"},
		// 没有 claude 时取归一后（排序）的首项，与 Node 的 || models[0] 一致。
		{"no claude", []string{"gemini-3", "gpt-5"}, "gemini-3"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := DefaultModel(testCase.models); got != testCase.want {
				t.Fatalf("DefaultModel(%v) = %q, want %q", testCase.models, got, testCase.want)
			}
		})
	}
}

func mustBuild(t *testing.T, rawConfig string) string {
	t.Helper()
	content, err := BuildGatewayConfig(rawConfig, testGateway())
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	return content
}

func mustDecode(t *testing.T, content string) *orderedObject {
	t.Helper()
	root, err := parseJSONC([]byte(content))
	if err != nil {
		t.Fatalf("output is not valid JSONC: %v\n%s", err, content)
	}
	decoded, err := decodeObject([]byte(content), root)
	if err != nil {
		t.Fatalf("decodeObject() error = %v", err)
	}
	return decoded
}

func mustObject(t *testing.T, root *orderedObject, path ...string) *orderedObject {
	t.Helper()
	value := mustPath(t, root, path...)
	object, ok := value.(*orderedObject)
	if !ok {
		t.Fatalf("path %v = %T, want object", path, value)
	}
	return object
}

func mustPath(t *testing.T, root *orderedObject, path ...string) any {
	t.Helper()
	current := any(root)
	for _, segment := range path {
		object, ok := current.(*orderedObject)
		if !ok {
			t.Fatalf("path %v: %T is not an object", path, current)
		}
		value, found := object.get(segment)
		if !found {
			t.Fatalf("path %v: %q missing", path, segment)
		}
		current = value
	}
	return current
}
