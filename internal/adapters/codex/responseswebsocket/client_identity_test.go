package responseswebsocket

import (
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

// TestProjectHandshakeHeadersFollowsGenuineCodexClient 使用 Codex CLI 0.158.0-alpha.2.1
// 实测握手头：身份与会话元数据跟随客户端，不再自报固定的 0.146 与凭空的 Version。
func TestProjectHandshakeHeadersFollowsGenuineCodexClient(t *testing.T) {
	t.Parallel()

	source := make(http.Header)
	source.Set("User-Agent", "codex_exec/0.158.0-alpha.2.1 (Mac OS 27.0.0; arm64) tmux-256color (codex_exec; 0.158.0-alpha.2.1)")
	source.Set("Originator", "codex_exec")
	source.Set("OpenAI-Beta", "untrusted-beta")
	source.Set("x-codex-turn-metadata", `{"model":"gpt-6-astra","reasoning_effort":"xhigh"}`)
	source.Set("x-codex-beta-features", "remote_compaction_v2")
	source.Set("x-codex-window-id", "window-1")
	source.Set("thread-id", "thread-1")
	source.Set("Authorization", "Bearer client-key")
	header := projectHandshakeHeaders(source, "0.170.0")

	if header.Get("Originator") != "codex_exec" ||
		!strings.HasPrefix(header.Get("User-Agent"), "codex_exec/0.158.0") ||
		header.Get("Version") != "" ||
		header.Get("x-codex-turn-metadata") == "" ||
		header.Get("x-codex-beta-features") != "remote_compaction_v2" ||
		header.Get("x-codex-window-id") != "window-1" ||
		header.Get("thread-id") != "thread-1" ||
		header.Get("OpenAI-Beta") != BetaHeaderValue ||
		header.Get("Authorization") != "" {
		t.Fatalf("handshake headers = %#v", header)
	}
}

// TestProjectHandshakeHeadersFallsBackForNonCodexClients 验证无法证明是 Codex 客户端时
// 使用固定兜底身份，且不透传会话元数据或含控制字符的头。
func TestProjectHandshakeHeadersFallsBackForNonCodexClients(t *testing.T) {
	t.Parallel()

	for name, source := range map[string]http.Header{
		"browser":        {"User-Agent": {"Mozilla/5.0"}, "x-codex-window-id": {"w"}},
		"spoofed origin": {"User-Agent": {"other/1.0"}, "Originator": {"codex_exec"}},
		"bad originator": {"User-Agent": {"Codex Desktop/1"}, "Originator": {"Codex Desktop"}},
		"control chars":  {"User-Agent": {"codex_exec/1\r\nX-Evil: 1"}, "Originator": {"codex_exec"}},
	} {
		header := projectHandshakeHeaders(source, "0.170.0")
		if header.Get("Originator") != codexidentity.Originator ||
			header.Get("User-Agent") != "codex_cli_rs/0.170.0" ||
			header.Get("Version") != "0.170.0" ||
			header.Get("x-codex-window-id") != "" {
			t.Fatalf("%s: handshake headers = %#v", name, header)
		}
	}
}
