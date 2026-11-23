package webuisshapi

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

func TestMCPEnabledForSessionGate(t *testing.T) {
	enabled, err := mcpEnabledForSession(t.TempDir(), "", "codex", true, nil)
	if err != nil || enabled {
		t.Fatalf("noMcp should disable: enabled=%v err=%v", enabled, err)
	}
	enabled, err = mcpEnabledForSession(t.TempDir(), "", "codex", false, nil)
	if err != nil || !enabled {
		t.Fatalf("default should enable: enabled=%v err=%v", enabled, err)
	}
	enabled, err = mcpEnabledForSession(t.TempDir(), "", "codex", false, []string{"aih_remote"})
	if err != nil || !enabled {
		t.Fatalf("explicit allow should enable: enabled=%v err=%v", enabled, err)
	}
	if _, err := mcpEnabledForSession(t.TempDir(), "", "codex", false, []string{"missing"}); err == nil {
		t.Fatal("out-of-policy selection should fail")
	}
}

func TestConnectorLaunchNoMcpArgs(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("codex CLI unavailable")
	}
	_, args, _, err := buildConnectorAgentLaunch(
		t.TempDir(), "wc-test", "codex", "http://127.0.0.1:1/tools", "token",
		remoteconnector.Capabilities{}, "", true, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(args, " "), "mcp_servers.aih_remote") {
		t.Fatalf("noMcp launch still carries MCP: %v", args)
	}
	_, args, _, err = buildConnectorAgentLaunch(
		t.TempDir(), "wc-test", "codex", "http://127.0.0.1:1/tools", "token",
		remoteconnector.Capabilities{}, "", false, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "mcp_servers.aih_remote") {
		t.Fatalf("default launch lost MCP: %v", args)
	}
}
