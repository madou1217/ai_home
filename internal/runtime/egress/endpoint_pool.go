package egress

import (
	"context"
	"errors"
	"hash/fnv"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// EndpointPoolProxy 是“无内核直连池”选出的一个可直接使用的代理出口。
//
// 只有协议本身就能直接作为 URL 使用时才会出现在这里：HTTP(S)、SOCKS5/5h
// 与 AIH 管理的 SSH 环回隧道。加密订阅节点仍需要 mihomo/sing-box 等内核。
type EndpointPoolProxy struct {
	ProxyURL string
	NodeName string
	NodeID   string
	Identity string
	Protocol string
}

var endpointPoolCursor atomic.Uint64

// SelectEndpointPoolProxy 在不启动 mihomo 的前提下，按池绑定范围/策略选一个
// 可直接使用的 HTTP(S)/SOCKS/SSH 出口。
//
// 这覆盖“本机没有 mihomo”时的出口池能力；加密协议节点会被跳过并报告
// egress_pool_no_endpoint_nodes，而不是静默退回直连。
func SelectEndpointPoolProxy(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
	binding *agyegress.Binding,
) (*EndpointPoolProxy, error) {
	return selectEndpointPoolProxy(ctx, aiHomeDir, accountRef, binding, true)
}

// SelectEndpointPoolProxyStable 用于展示：shared 策略不推进全局轮换游标。
func SelectEndpointPoolProxyStable(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
	binding *agyegress.Binding,
) (*EndpointPoolProxy, error) {
	return selectEndpointPoolProxy(ctx, aiHomeDir, accountRef, binding, false)
}

func selectEndpointPoolProxy(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
	binding *agyegress.Binding,
	advance bool,
) (*EndpointPoolProxy, error) {
	if binding == nil || binding.Mode != agyegress.ModePool {
		return nil, errors.New("egress_pool_binding_required")
	}
	catalog, err := ReadEgressPoolCatalog(aiHomeDir)
	if err != nil || len(catalog.Nodes) == 0 {
		return nil, errors.New("egress_pool_no_endpoint_nodes")
	}
	scope, err := endpointPoolScope(binding, catalog)
	if err != nil {
		return nil, err
	}
	candidates := make([]ProxyNode, 0, len(catalog.Nodes))
	for _, node := range catalog.Nodes {
		if !endpointPoolEligible(node) {
			continue
		}
		if scope != nil {
			if _, ok := scope[NodeExitIdentity(node)]; !ok {
				continue
			}
		}
		candidates = append(candidates, node)
	}
	if len(candidates) == 0 {
		return nil, errors.New("egress_pool_no_endpoint_nodes")
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return NodeExitIdentity(candidates[i]) < NodeExitIdentity(candidates[j])
	})

	strategy := strings.ToLower(strings.TrimSpace(binding.PoolStrategy))
	start := 0
	if strategy == "shared" && advance {
		start = int(endpointPoolCursor.Add(1)-1) % len(candidates)
	} else {
		start = int(hashAccountRef(accountRef) % uint32(len(candidates)))
	}
	var lastErr error
	for offset := 0; offset < len(candidates); offset++ {
		node := candidates[(start+offset)%len(candidates)]
		proxyURL, buildErr := endpointPoolProxyURL(aiHomeDir, node)
		if buildErr != nil {
			lastErr = buildErr
			continue
		}
		return &EndpointPoolProxy{
			ProxyURL: proxyURL,
			NodeName: node.Name,
			NodeID:   node.ID,
			Identity: NodeExitIdentity(node),
			Protocol: NormalizeProtocol(node.Protocol),
		}, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("egress_pool_no_endpoint_nodes")
}

// EndpointPoolNodeCount 返回可直连的池节点数（忽略账号范围）。
func EndpointPoolNodeCount(aiHomeDir string) int {
	catalog, err := ReadEgressPoolCatalog(aiHomeDir)
	if err != nil {
		return 0
	}
	count := 0
	for _, node := range catalog.Nodes {
		if endpointPoolEligible(node) {
			count++
		}
	}
	return count
}

func endpointPoolEligible(node ProxyNode) bool {
	if !IsUsableNode(node) || IsInformationalNode(node.Name) {
		return false
	}
	if available, ok := node.Raw["available"].(bool); ok && !available {
		return false
	}
	if lifecycle := strings.ToLower(stringField(node.Raw["lifecycle"])); lifecycle != "" && lifecycle != "ready" {
		return false
	}
	if node.Raw["managedBy"] == "sshproxy" {
		return node.managedVerified
	}
	switch NormalizeProtocol(node.Protocol) {
	case "http", "https", "socks5", "socks5h":
		return true
	default:
		return false
	}
}

func endpointPoolScope(binding *agyegress.Binding, catalog CatalogResult) (map[string]struct{}, error) {
	scope := binding.PoolScope
	if scope == nil || strings.EqualFold(strings.TrimSpace(scope.Kind), "all") {
		return nil, nil
	}
	allowed := map[string]struct{}{}
	switch strings.ToLower(strings.TrimSpace(scope.Kind)) {
	case "nodes":
		for _, identity := range scope.Nodes {
			identity = strings.TrimSpace(identity)
			if identity != "" {
				allowed[identity] = struct{}{}
			}
		}
	case "groups":
		wanted := map[string]struct{}{}
		for _, groupID := range scope.Groups {
			groupID = strings.TrimSpace(groupID)
			if groupID != "" {
				wanted[groupID] = struct{}{}
			}
		}
		for _, group := range catalog.Groups {
			if _, ok := wanted[group.ID]; !ok {
				continue
			}
			for _, identity := range group.Identities {
				allowed[identity] = struct{}{}
			}
		}
	default:
		return nil, errors.New("egress_pool_scope_invalid")
	}
	if len(allowed) == 0 {
		return nil, errors.New("egress_pool_no_endpoint_nodes")
	}
	return allowed, nil
}

func endpointPoolProxyURL(aiHomeDir string, node ProxyNode) (string, error) {
	if node.Raw["managedBy"] == "sshproxy" {
		proxyURL, err := ManagedSSHProxyURL(aiHomeDir, node.ID)
		if err != nil {
			return "", err
		}
		return proxyURL, nil
	}
	scheme := NormalizeProtocol(node.Protocol)
	if scheme != "http" && scheme != "https" && scheme != "socks5" && scheme != "socks5h" {
		return "", errors.New("egress_pool_endpoint_protocol_unsupported")
	}
	server := strings.TrimSpace(node.Server)
	if server == "" || node.Port <= 0 {
		return "", errors.New("egress_pool_endpoint_invalid")
	}
	endpoint := &url.URL{
		Scheme: scheme,
		Host:   net.JoinHostPort(server, strconv.Itoa(node.Port)),
	}
	if node.Username != "" || node.Password != "" {
		endpoint.User = url.UserPassword(node.Username, node.Password)
	}
	return endpoint.String(), nil
}

func hashAccountRef(accountRef string) uint32 {
	hasher := fnv.New32a()
	_, _ = hasher.Write([]byte(strings.TrimSpace(accountRef)))
	return hasher.Sum32()
}
