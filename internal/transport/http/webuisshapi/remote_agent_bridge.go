package webuisshapi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// readMCPBridgeSharingMode reads config:server.mcpBridgeSharing at launch time.
// A missing or damaged key keeps the default (global).
func readMCPBridgeSharingMode(aiHomeDir string) string {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return serverconfig.MCPBridgeSharingGlobal
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, path, appstate.KeyServerConfig)
	if err != nil || !found {
		return serverconfig.MCPBridgeSharingGlobal
	}
	return serverconfig.ParseMCPBridgeSharing(raw)
}

// attachMCPBridge adds the shared socket and session token to a launch context.
// It reports whether sharing is active so the caller can pick the light shim.
func attachMCPBridge(aiHomeDir, workspaceID string, launchContext map[string]any) bool {
	mode := readMCPBridgeSharingMode(aiHomeDir)
	if mode == serverconfig.MCPBridgeSharingOff {
		return false
	}
	socketPath, sessionToken, ok := ensureMCPBridge(aiHomeDir, workspaceID, mode)
	if !ok {
		return false
	}
	launchContext["bridgeSocket"] = socketPath
	launchContext["sessionToken"] = sessionToken
	return true
}

// mcpBridgeChildCommand prefers the dedicated tiny shim binary; when it is not
// installed (developer trees), the server binary's __mcp-remote-tools mode acts
// as the shim so sharing still works.
func mcpBridgeChildCommand(executable string, shared bool) (string, []string) {
	if shared {
		shim := filepath.Join(filepath.Dir(executable), "aih-mcp-shim")
		if info, err := os.Stat(shim); err == nil && !info.IsDir() && strings.TrimSpace(shim) != "" {
			return shim, nil
		}
	}
	return executable, []string{"__mcp-remote-tools"}
}
