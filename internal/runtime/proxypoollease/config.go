package proxypoollease

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/egressengine"
	"github.com/madou1217/ai_home/internal/runtime/egress"
)

// writeConfig 交给出口引擎插件编译单节点租约配置。
//
// 主体只写插件返回的配置与启动参数，不再认识任何具体内核字段：
// 回环绑定、入口认证、不持久化选择都由插件按 Lease 契约生成。
func writeConfig(
	ctx context.Context,
	dir string,
	ports *reservedPorts,
	node egress.ProxyNode,
	engine egressengine.Engine,
	resolved egressengine.ResolveResult,
) (secret, token string, args []string, err error) {
	credentials := make([]byte, 64)
	if _, err := rand.Read(credentials); err != nil {
		return "", "", nil, errors.New("proxy_pool_lease_random_failed")
	}
	secret = hex.EncodeToString(credentials[:32])
	token = hex.EncodeToString(credentials[32:])
	options := make(map[string]any, len(node.Raw))
	for key, value := range node.Raw {
		options[key] = value
	}
	// 非回环节点绑定物理网卡，避免租约流量被宿主 TUN 再接管；
	// SSH 的本机代理是回环地址，必须留空，否则内核会绕开它。
	interfaceName := ""
	if !loopbackNode(node) {
		interfaceName = egress.ResolvePhysicalInterface(nil)
	}
	spec, compileErr := engine.Compile(ctx, egressengine.CompileRequest{
		Nodes: []egressengine.Node{{
			ID: node.ID, Name: node.Name, Protocol: node.Protocol,
			Server: node.Server, Port: node.Port, Options: options,
		}},
		MixedPort:      ports.proxyPort,
		ControllerPort: ports.controlPort,
		Secret:         secret,
		InterfaceName:  interfaceName,
		Lease: &egressengine.Lease{
			BindAddress: egress.PoolBindHost,
			IngressAuth: []string{"aih:" + token},
		},
		Version: resolved.Version,
	})
	if compileErr != nil || len(spec.Config) == 0 || len(spec.NodeTags) != 1 {
		return "", "", nil, errors.New("proxy_pool_lease_node_config_invalid")
	}
	fileName := filepath.Base(strings.TrimSpace(spec.ConfigFileName))
	if fileName == "" || fileName == "." || fileName == string(filepath.Separator) {
		return "", "", nil, errors.New("proxy_pool_lease_node_config_invalid")
	}
	args = expandArgs(spec.Args, filepath.Join(dir, fileName), dir)
	if len(args) == 0 {
		return "", "", nil, errors.New("proxy_pool_lease_node_config_invalid")
	}
	path := filepath.Join(dir, fileName)
	if err := os.WriteFile(path, spec.Config, 0600); err != nil {
		return "", "", nil, errors.New("proxy_pool_lease_config_write_failed")
	}
	return secret, token, args, nil
}

// expandArgs 展开插件启动参数中的 {{config}}/{{dir}}，与出口池宿主约定一致。
func expandArgs(raw []string, configPath, workDir string) []string {
	out := make([]string, 0, len(raw))
	for _, arg := range raw {
		if strings.TrimSpace(arg) == "" {
			continue
		}
		arg = strings.ReplaceAll(arg, "{{config}}", configPath)
		arg = strings.ReplaceAll(arg, "{{dir}}", workDir)
		out = append(out, arg)
	}
	return out
}

func loopbackNode(node egress.ProxyNode) bool {
	if node.Raw["managedBy"] == "sshproxy" {
		return true
	}
	host := strings.Trim(strings.TrimSpace(node.Server), "[]")
	if ip := net.ParseIP(host); ip != nil {
		return true
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	return host == "localhost" || strings.HasSuffix(host, ".localhost")
}
