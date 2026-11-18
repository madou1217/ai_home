package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

// Only current-process-owned, authenticated loopback endpoints are admitted.
// A hand-edited/imported node merely claiming source=ssh does not qualify.
func verifiedManagedSSH(aiHome string, node ProxyNode) bool {
	if node.Raw["managedBy"] != "sshproxy" || node.Raw["source"] != "ssh" || node.Server != "127.0.0.1" || node.Port < 1 || node.Password == "" {
		return false
	}
	connection := stringField(node.Raw["sshConnectionId"])
	if connection == "" || node.ID != "ssh:"+connection {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(aiHome, "run", "ssh-proxy-endpoints.json"))
	if err != nil {
		return false
	}
	var registry struct {
		OwnerPID  int `json:"ownerPid"`
		Endpoints map[string]struct {
			Port      int    `json:"port"`
			TokenHash string `json:"tokenHash"`
			OwnerPID  int    `json:"ownerPid"`
			NodeID    string `json:"nodeId"`
		} `json:"endpoints"`
	}
	if json.Unmarshal(raw, &registry) != nil || !platform.ProcessAlive(registry.OwnerPID) {
		return false
	}
	entry, ok := registry.Endpoints[connection]
	sum := sha256.Sum256([]byte(node.Password))
	return ok && entry.OwnerPID == registry.OwnerPID && entry.Port == node.Port && entry.NodeID == node.ID && entry.TokenHash == hex.EncodeToString(sum[:])
}
func NodeExitIdentity(node ProxyNode) string {
	if strings.HasPrefix(node.ID, "ssh:") && node.Raw["managedBy"] == "sshproxy" {
		return "ssh|" + strings.TrimPrefix(node.ID, "ssh:")
	}
	return BuildExitIdentity(node.Protocol, node.Server, node.Port)
}
func NodeEntityID(node ProxyNode) string {
	if strings.HasPrefix(node.ID, "ssh:") && node.Raw["managedBy"] == "sshproxy" {
		return node.ID
	}
	return BuildNodeEntityID(node.Protocol, node.Server, node.Port)
}
