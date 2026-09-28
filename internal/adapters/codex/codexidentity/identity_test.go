package codexidentity

import (
	"net/http"
	"testing"
)

// TestVersionFromClientHeadersTrustsOnlyGenuineCodexClients 使用 Codex CLI 0.158.0-alpha.2.1
// 实测 User-Agent，并拒绝伪造 originator、前缀不符或版本不完整的头。
func TestVersionFromClientHeadersTrustsOnlyGenuineCodexClients(t *testing.T) {
	t.Parallel()

	genuine := http.Header{
		"Originator": {"codex_exec"},
		"User-Agent": {"codex_exec/0.158.0-alpha.2.1 (Mac OS 27.0.0; arm64) tmux-256color (codex_exec; 0.158.0-alpha.2.1)"},
	}
	version, ok := VersionFromClientHeaders(genuine)
	if !ok || version.String() != "0.158.0-alpha.2.1" {
		t.Fatalf("genuine = %q %v", version, ok)
	}
	for name, header := range map[string]http.Header{
		"no originator":     {"User-Agent": {"codex_exec/0.158.0"}},
		"foreign ua":        {"Originator": {"codex_exec"}, "User-Agent": {"curl/8.0"}},
		"other originator":  {"Originator": {"codex_exec"}, "User-Agent": {"codex_cli_rs/0.160.0"}},
		"garbage version":   {"Originator": {"codex_exec"}, "User-Agent": {"codex_exec/latest"}},
		"partial version":   {"Originator": {"codex_exec"}, "User-Agent": {"codex_exec/0.158"}},
		"non codex product": {"Originator": {"claude"}, "User-Agent": {"claude/2.1.283"}},
	} {
		if _, ok := VersionFromClientHeaders(header); ok {
			t.Fatalf("%s accepted", name)
		}
	}
	if UserAgent("0.170.0") != "codex_cli_rs/0.170.0" || UserAgent("") != "codex_cli_rs/"+Floor {
		t.Fatalf("UserAgent = %q / %q", UserAgent("0.170.0"), UserAgent(""))
	}
}
