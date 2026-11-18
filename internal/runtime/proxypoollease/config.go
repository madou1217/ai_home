package proxypoollease

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/egress"
)

func writeConfig(dir string, ports *reservedPorts, node egress.ProxyNode) (path, secret, token string, err error) {
	credentials := make([]byte, 64)
	if _, err := rand.Read(credentials); err != nil {
		return "", "", "", errors.New("proxy_pool_lease_random_failed")
	}
	secret = hex.EncodeToString(credentials[:32])
	token = hex.EncodeToString(credentials[32:])
	input := egress.PoolConfigInput{
		Nodes:          []egress.ProxyNode{node},
		MixedPort:      ports.proxyPort,
		ControllerPort: ports.controlPort,
		Secret:         secret,
	}
	if loopbackNode(node) {
		// A forced physical interface prevents reaching SSH's localhost proxy.
		// A non-nil empty value disables the builder's automatic interface choice.
		empty := ""
		input.InterfaceName = &empty
	}
	compiled, err := egress.BuildEgressPoolConfig(input)
	if err != nil || compiled == nil || len(compiled.NodeNames) != 1 {
		return "", "", "", errors.New("proxy_pool_lease_node_config_invalid")
	}
	compiled.Config["bind-address"] = egress.PoolBindHost
	compiled.Config["ipv6"] = false
	// Authenticate mixed ingress as well as the controller: an unrelated
	// listener winning the handoff race must never become the task's outlet.
	compiled.Config["authentication"] = []string{"aih:" + token}
	compiled.Config["skip-auth-prefixes"] = []string{}
	compiled.Config["profile"] = map[string]any{"store-selected": false, "store-fake-ip": false}
	data, err := json.Marshal(compiled.Config)
	if err != nil {
		return "", "", "", errors.New("proxy_pool_lease_node_config_invalid")
	}
	path = filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return "", "", "", errors.New("proxy_pool_lease_config_write_failed")
	}
	return path, secret, token, nil
}

func loopbackNode(node egress.ProxyNode) bool {
	if node.Raw["managedBy"] == "sshproxy" {
		return true
	}
	host := strings.Trim(strings.TrimSpace(node.Server), "[]")
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}
