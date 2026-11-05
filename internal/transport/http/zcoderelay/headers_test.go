package zcoderelay

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
	"time"
)

func deterministicInput(seed byte, now time.Time) HeaderInput {
	return HeaderInput{
		AppVersion: "3.16.3",
		DeviceMid:  "mid-abc",
		OSVersion:  "23.5.0",
		SessionKey: "session-key-1",
		Random:     bytes.NewReader(bytes.Repeat([]byte{seed}, 128)),
		Now:        func() time.Time { return now },
	}
}

func TestApplyIdentityHeadersFillsClientProfile(t *testing.T) {
	now := time.UnixMilli(1793884800000)
	headers := http.Header{}
	ApplyIdentityHeaders(headers, deterministicInput(0x11, now))

	expected := map[string]string{
		"X-Zcode-App-Version":  "3.16.3",
		"X-Device-Mid":         "mid-abc",
		"X-Title":              CLITitle,
		"X-Release-Channel":    CLIReleaseChannel,
		"X-Zcode-Agent":        IdentityAgent,
		"X-Zcode-Query-Source": "main_turn",
		"X-Zcode-Session-Type": "main",
		"X-Os-Version":         "23.5.0",
		"Anthropic-Beta":       AnthropicBeta,
		"User-Agent":           "ZCode/3.16.3 " + CLIUserAgentSuffix,
	}
	for name, want := range expected {
		if got := headers.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if queryID := headers.Get("x-query-id"); !isUUID(queryID) || queryID[14] != '7' {
		t.Errorf("x-query-id = %q, want UUIDv7", queryID)
	}
	for _, name := range []string{"x-request-id", "x-zcode-trace-id"} {
		if value := headers.Get(name); !isUUID(value) || value[14] != '4' {
			t.Errorf("%s = %q, want UUIDv4", name, value)
		}
	}
	if headers.Get("x-session-id") == "" || headers.Get("x-session-id") != headers.Get("X-Session-Id") {
		t.Error("x-session-id 必须同时写入两种大小写且一致")
	}
}

func TestApplyIdentityHeadersKeepsClientValuesAndOverridesHostProfile(t *testing.T) {
	now := time.UnixMilli(1793884800000)
	headers := http.Header{}
	headers.Set("anthropic-beta", "client-beta")
	headers.Set("user-agent", "client-ua")
	headers.Set("x-query-id", "client-query")
	input := deterministicInput(0x22, now)
	input.Base = map[string]string{
		"X-Title":           "Z Code@electron",
		"X-Release-Channel": "stable",
		"x-extra":           "kept",
	}
	ApplyIdentityHeaders(headers, input)

	if got := headers.Get("anthropic-beta"); got != "client-beta" {
		t.Errorf("客户端自带的 anthropic-beta 不应被覆盖: %q", got)
	}
	if got := headers.Get("x-query-id"); got != "client-query" {
		t.Errorf("客户端自带的 x-query-id 不应被覆盖: %q", got)
	}
	if got := headers.Get("X-Title"); got != CLITitle {
		t.Errorf("X-Title 必须强制成 CLI 形态: %q", got)
	}
	if got := headers.Get("X-Release-Channel"); got != CLIReleaseChannel {
		t.Errorf("X-Release-Channel 必须强制成 CLI 形态: %q", got)
	}
	if !strings.HasPrefix(headers.Get("User-Agent"), "ZCode/3.16.3 ") {
		t.Errorf("UA 必须强制成 ZCode 形态: %q", headers.Get("User-Agent"))
	}
	if got := headers.Get("x-extra"); got != "kept" {
		t.Errorf("宿主元数据的其它头应保留: %q", got)
	}
}

func TestResolveSessionID(t *testing.T) {
	random := bytes.NewReader(bytes.Repeat([]byte{0x33}, 64))
	const uuid = "A1B2C3D4-E5F6-4789-8ABC-DEF012345678"
	if got := ResolveSessionID(uuid, "mid", random); got != strings.ToLower(uuid) {
		t.Fatalf("UUID 会话键应原样透传并小写: %q", got)
	}
	first := ResolveSessionID("same-session", "mid", random)
	second := ResolveSessionID("same-session", "mid", random)
	if first != second {
		t.Fatalf("同一会话键必须派生稳定 UUID: %q vs %q", first, second)
	}
	if !isUUID(first) {
		t.Fatalf("派生结果必须是 UUID 形态: %q", first)
	}
	if got := ResolveSessionID("", "mid", random); got == "" {
		t.Fatal("没有会话键时应回退到 device mid")
	}
}

func TestUUIDv7UsesClockPrefix(t *testing.T) {
	now := time.UnixMilli(0x0123456789ab)
	value, err := NewUUIDv7(bytes.NewReader(make([]byte, 16)), now)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(value, "01234567-89ab-7") {
		t.Fatalf("UUIDv7 时间前缀不对: %q", value)
	}
}
