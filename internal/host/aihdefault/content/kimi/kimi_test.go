package kimi

import (
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

// 内容构造必须能直接作为 aihdefault 的 BuildContent 使用。
var _ aihdefault.BuildContent = BuildGatewayContent(ServerConfig{})

const quote = string(rune(34))

func managedBlock(apiKey string, baseURL string) string {
	return strings.Join([]string{
		ManagedBlockStart,
		"[providers." + quote + GatewayProviderID + quote + "]",
		"type = " + quote + "kimi" + quote,
		"api_key = " + quote + apiKey + quote,
		"base_url = " + quote + baseURL + quote,
		"",
		"[models." + quote + GatewayModelID + quote + "]",
		"provider = " + quote + GatewayProviderID + quote,
		"model = " + quote + GatewayModel + quote,
		"max_context_size = 262144",
		ManagedBlockEnd,
	}, "\n")
}

func defaultBlock() string {
	return managedBlock("dummy", "http://127.0.0.1:9527/v1")
}

func build(t *testing.T, raw string, server ServerConfig) string {
	t.Helper()
	result, err := BuildGatewayConfig(raw, server)
	if err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
	return result
}

func TestBuildGatewayConfigEmptyFile(t *testing.T) {
	want := "default_model = " + quote + GatewayModelID + quote + "\n\n\n" + defaultBlock() + "\n"
	if got := build(t, "", ServerConfig{}); got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func TestBuildGatewayConfigPatchesRootAndKeepsTables(t *testing.T) {
	raw := "# user config\n" +
		"default_model = " + quote + "kimi-k2" + quote + "\n" +
		"temperature = 0.2\n" +
		"\n" +
		"[providers.other]\n" +
		"type = " + quote + "openai" + quote + "\n"
	want := "# user config\n" +
		"default_model = " + quote + GatewayModelID + quote + "\n" +
		"temperature = 0.2\n\n" +
		"[providers.other]\n" +
		"type = " + quote + "openai" + quote + "\n\n" +
		defaultBlock() + "\n"
	if got := build(t, raw, ServerConfig{}); got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func TestBuildGatewayConfigAddsDefaultModelWhenMissing(t *testing.T) {
	raw := "temperature = 0.2\n[session]\nfoo = true\n"
	want := "default_model = " + quote + GatewayModelID + quote + "\n" +
		"temperature = 0.2\n" +
		"[session]\n" +
		"foo = true\n\n" +
		defaultBlock() + "\n"
	if got := build(t, raw, ServerConfig{}); got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func TestBuildGatewayConfigLeavesTableDefaultModelAlone(t *testing.T) {
	raw := "[profiles.x]\ndefault_model = " + quote + "other" + quote + "\n"
	want := "default_model = " + quote + GatewayModelID + quote + "\n" +
		"[profiles.x]\ndefault_model = " + quote + "other" + quote + "\n\n" +
		defaultBlock() + "\n"
	if got := build(t, raw, ServerConfig{}); got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func TestBuildGatewayConfigIsIdempotent(t *testing.T) {
	first := build(t, "# top\ntemperature = 1\n", ServerConfig{})
	second := build(t, first, ServerConfig{})
	if first != second {
		t.Fatalf("second build changed content:\n%q\n%q", first, second)
	}
	third := build(t, second, ServerConfig{})
	if first != third {
		t.Fatalf("third build changed content")
	}
}

func TestBuildGatewayConfigReplacesManagedBlockAndKeepsFollowingKeys(t *testing.T) {
	raw := "temperature = 1\n\n" + defaultBlock() + "\nafter = 2\n"
	want := "default_model = " + quote + GatewayModelID + quote + "\n" +
		"temperature = 1\n\n\nafter = 2\n\n\n" + defaultBlock() + "\n"
	if got := build(t, raw, ServerConfig{}); got != want {
		t.Fatalf("content = %q, want %q", got, want)
	}
}

func TestBuildGatewayConfigRejectsBrokenManagedMarkers(t *testing.T) {
	cases := map[string]string{
		"start only":       ManagedBlockStart + "\ntemperature = 1\n",
		"end only":         "temperature = 1\n" + ManagedBlockEnd + "\n",
		"reversed":         ManagedBlockEnd + "\n" + ManagedBlockStart + "\n",
		"duplicate":        ManagedBlockStart + "\n" + ManagedBlockEnd + "\n" + ManagedBlockStart + "\n",
		"duplicate no end": ManagedBlockStart + "\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := BuildGatewayConfig(raw, ServerConfig{}); !errors.Is(err, ErrInvalidManagedBlock) {
				t.Fatalf("err = %v, want ErrInvalidManagedBlock", err)
			}
		})
	}
}

func TestBuildGatewayConfigRejectsProviderConflicts(t *testing.T) {
	cases := map[string]string{
		"quoted table":  "[providers." + quote + "aih-server" + quote + "]\ntype = " + quote + "kimi" + quote + "\n",
		"bare table":    "[providers.aih-server]\ntype = " + quote + "kimi" + quote + "\n",
		"table key":     "[providers]\naih-server = { type = " + quote + "kimi" + quote + " }\n",
		"dotted key":    "providers." + quote + "aih-server" + quote + ".type = " + quote + "kimi" + quote + "\n",
		"nested table":  "[providers." + quote + "aih-server" + quote + ".extra]\nvalue = 1\n",
		"model table":   "[models." + quote + GatewayModelID + quote + "]\nprovider = " + quote + "x" + quote + "\n",
		"model literal": "[models.'" + GatewayModelID + "']\nprovider = " + quote + "x" + quote + "\n",
		"model key":     "[models]\n" + quote + GatewayModelID + quote + " = { provider = " + quote + "x" + quote + " }\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := BuildGatewayConfig(raw, ServerConfig{}); !errors.Is(err, ErrProviderConflict) {
				t.Fatalf("err = %v, want ErrProviderConflict", err)
			}
		})
	}
}

func TestBuildGatewayConfigAllowsUnrelatedModelsAndProviders(t *testing.T) {
	raw := "[providers.other]\ntype = " + quote + "openai" + quote + "\n" +
		"[models." + quote + "aih-server/other" + quote + "]\nprovider = " + quote + "other" + quote + "\n"
	if _, err := BuildGatewayConfig(raw, ServerConfig{}); err != nil {
		t.Fatalf("BuildGatewayConfig() error = %v", err)
	}
}

func TestBuildGatewayConfigRejectsInvalidTOML(t *testing.T) {
	cases := map[string]string{
		"bare words":         "not toml\n",
		"missing value":      "key =\n",
		"unterminated arr":   "key = [1, 2\n",
		"unterminated hdr":   "[broken\n",
		"unterminated str":   "key = " + quote + "value\n",
		"bad number":         "key = 01\n",
		"trailing scalar":    "key = true false\n",
		"indented duplicate": "  default_model = " + quote + "other" + quote + "\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := BuildGatewayConfig(raw, ServerConfig{}); !errors.Is(err, ErrInvalidTOML) {
				t.Fatalf("err = %v, want ErrInvalidTOML", err)
			}
		})
	}
}

func TestBaseURLMatchesNodeNormalization(t *testing.T) {
	cases := []struct {
		name   string
		server ServerConfig
		want   string
	}{
		{"default", ServerConfig{}, "http://127.0.0.1:9527/v1"},
		{"wildcard", ServerConfig{Host: "0.0.0.0", Port: 8080}, "http://127.0.0.1:8080/v1"},
		{"ipv6", ServerConfig{Host: "::1"}, "http://[::1]:9527/v1"},
		{"bracketed ipv6", ServerConfig{Host: "[::1]", Port: 7000}, "http://[::1]:7000/v1"},
		{"trimmed host", ServerConfig{Host: " localhost ", Port: 70000}, "http://localhost:9527/v1"},
		{"negative port", ServerConfig{Host: "10.0.0.2", Port: -1}, "http://10.0.0.2:9527/v1"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := BaseURL(testCase.server); got != testCase.want {
				t.Fatalf("BaseURL() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestBuildGatewayConfigUsesAPIKeyOrClientKey(t *testing.T) {
	cases := []struct {
		name   string
		server ServerConfig
		want   string
	}{
		{"api key trimmed", ServerConfig{APIKey: " secret "}, "secret"},
		{"client key fallback", ServerConfig{ClientKey: " client "}, "client"},
		{"blank api key wins", ServerConfig{APIKey: "   ", ClientKey: "client"}, "dummy"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			content := build(t, "", testCase.server)
			want := "api_key = " + quote + testCase.want + quote
			if !strings.Contains(content, want) {
				t.Fatalf("content missing %q: %q", want, content)
			}
		})
	}
}

func TestQuoteJSONEscapesLikeJSONStringify(t *testing.T) {
	backslash := string(rune(92))
	value := "a" + quote + "b" + backslash + "c\nd" + string(rune(1))
	want := quote + "a" + backslash + quote + "b" + backslash + backslash +
		"c" + backslash + "n" + "d" + backslash + "u0001" + quote
	if got := quoteJSON(value); got != want {
		t.Fatalf("quoteJSON() = %q, want %q", got, want)
	}
	content := build(t, "", ServerConfig{APIKey: value})
	if !strings.Contains(content, "api_key = "+want) {
		t.Fatalf("content missing escaped key: %q", content)
	}
}

func TestBuildGatewayContentAdapterIgnoresExisted(t *testing.T) {
	builder := BuildGatewayContent(ServerConfig{Host: "10.0.0.2", Port: 8123})
	missing, err := builder("", false)
	if err != nil {
		t.Fatalf("builder() error = %v", err)
	}
	existing, err := builder("", true)
	if err != nil {
		t.Fatalf("builder() error = %v", err)
	}
	if missing != existing {
		t.Fatal("existed changed generated content")
	}
	if !strings.Contains(missing, "base_url = "+quote+"http://10.0.0.2:8123/v1"+quote) {
		t.Fatalf("custom base_url missing: %q", missing)
	}
}
