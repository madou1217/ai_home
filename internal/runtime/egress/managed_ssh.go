package egress

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/platform"
)

// ManagedSSHProxyURL 把稳定引用 ssh:<connectionId> 解析成已认证的环回代理 URL。
//
// 只接受当前进程发布、令牌哈希匹配的 managed SSH 出口；连接未就绪、订阅被
// 停用或引用非法都返回错误。调用方必须失败关闭，不能回落到宿主网络。
func ManagedSSHProxyURL(aiHome string, reference string) (string, error) {
	text := strings.TrimSpace(reference)
	connectionID := strings.TrimPrefix(text, "ssh:")
	if connectionID == "" || connectionID == text {
		return "", errors.New("ssh_proxy_reference_invalid")
	}
	data, err := ReadProxyPoolData(aiHome)
	if err != nil {
		return "", err
	}
	for _, node := range data.Nodes {
		if node.ID != "ssh:"+connectionID {
			continue
		}
		if data.DisabledSubs[node.SubscriptionID] || !verifiedManagedSSH(aiHome, node) {
			return "", errors.New("ssh_proxy_not_ready")
		}
		server := strings.TrimSpace(node.Server)
		if server == "" || node.Port <= 0 {
			return "", errors.New("ssh_proxy_endpoint_invalid")
		}
		username := strings.TrimSpace(node.Username)
		if username == "" {
			username = "aih"
		}
		if strings.TrimSpace(node.Password) == "" {
			return "", errors.New("ssh_proxy_endpoint_invalid")
		}
		endpoint := &url.URL{
			Scheme: "http",
			Host:   net.JoinHostPort(server, strconv.Itoa(node.Port)),
			User:   url.UserPassword(username, node.Password),
		}
		return endpoint.String(), nil
	}
	return "", errors.New("ssh_proxy_not_found")
}

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
