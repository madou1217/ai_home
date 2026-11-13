package subaggregator

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	RelaySettingsEnv         = "AIH_RELAY_SETTINGS"
	RelayCredentialUsername  = "aih-relay"
	RelayCredentialsFile     = "credentials.json"
	RelayDefaultListenHost   = "127.0.0.1"
	RelayMaxChainDepth       = 8
	SingBoxRelayBasePort     = 23100
	MihomoRelayBasePort      = 23400
	RelayDefaultMaxPorts     = 256
	relayPortProbeWindow     = 64
	relayReadinessTimeout    = 6000 * time.Millisecond
	relayStopGrace           = 2000 * time.Millisecond
	relayCheckTimeout        = 15000 * time.Millisecond
	relayVersionProbeTimeout = 5000 * time.Millisecond
	relayDirectTag           = "relay-direct"
	relayInboundPrefix       = "relay-in-"
	relayOutboundPrefix      = "relay-out-"
	mihomoRelayProxyPrefix   = "relay-"
)

var (
	singBoxVerOutRegex = regexp.MustCompile(`(?i)sing-box\s+version\s+v?(\d+\.\d+(?:\.\d+)?)`)
	mihomoVerOutRegex  = regexp.MustCompile(`v(\d+\.\d+(?:\.\d+)?)`)
	safeProxyNameRegex = regexp.MustCompile(`[^\w.-]`)
)

// ParseRelaySettings 解析 AIH_RELAY_SETTINGS（逗号分隔的 key=value 串）。
func ParseRelaySettings(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		idx := strings.IndexByte(part, '=')
		if idx <= 0 {
			continue
		}
		k := strings.TrimSpace(part[:idx])
		v := strings.TrimSpace(part[idx+1:])
		if k == "" || v == "" {
			continue
		}
		if decoded, err := url.QueryUnescape(v); err == nil {
			out[k] = decoded
		} else {
			out[k] = v
		}
	}
	return out
}

// ReadRelaySetting 读取指定 key 的中转运行参数（不存在返回 fallback）。
func ReadRelaySetting(env map[string]string, key, fallback string) string {
	var raw string
	if env != nil {
		raw = env[RelaySettingsEnv]
	} else {
		raw = os.Getenv(RelaySettingsEnv)
	}
	fields := ParseRelaySettings(raw)
	if val, ok := fields[key]; ok && val != "" {
		return val
	}
	return fallback
}

// RelayCredentials 保存本机中转入站认证凭据。
type RelayCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Source   string `json:"source,omitempty"`
}

// ResolveRelayCredentials 从运行目录读取或生成 0600 凭据文件。
func ResolveRelayCredentials(runDir string) (RelayCredentials, error) {
	filePath := filepath.Join(runDir, RelayCredentialsFile)
	if raw, err := os.ReadFile(filePath); err == nil {
		var parsed RelayCredentials
		if json.Unmarshal(raw, &parsed) == nil {
			u := strings.TrimSpace(parsed.Username)
			p := strings.TrimSpace(parsed.Password)
			if u != "" && p != "" {
				return RelayCredentials{Username: u, Password: p, Source: "file"}, nil
			}
		}
	}
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return RelayCredentials{}, err
	}
	creds := RelayCredentials{
		Username: RelayCredentialUsername,
		Password: base64.RawURLEncoding.EncodeToString(buf),
		Source:   "generated",
	}
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return RelayCredentials{}, err
	}
	payload, _ := json.MarshalIndent(map[string]string{
		"username": creds.Username,
		"password": creds.Password,
	}, "", "  ")
	payload = append(payload, '\n')
	if err := writeFileAtomic0600(filePath, payload); err != nil {
		return RelayCredentials{}, err
	}
	return creds, nil
}

// ResolvedKernelBinary 描述找到的内核可执行文件与来源。
type ResolvedKernelBinary struct {
	Path    string
	Source  string
	Version string
}

// RelayKernelSpec 描述一种中转内核（sing-box / mihomo）的能力与查找规则。
type RelayKernelSpec struct {
	ID                      string
	Label                   string
	EnvField                string
	Aliases                 []string
	ConfigFileName          string
	BasePort                int
	MaxPorts                int
	VersionArgs             []string
	BuildDependentProtocols []string
	ParseVersion            func(string) string
	CheckArgs               func(configFile, runDir string) []string
	RunArgs                 func(configFile, runDir string) []string
	CanCompileNode          func(node ProxyNode, version string) bool
	CompileText             func(nodes []ProxyNode, opts RelayCompileOptions) RelayCompiledOutput
}

// RelayCompileOptions 控制中转配置编译参数。
type RelayCompileOptions struct {
	ListenHost    string
	AdvertiseHost string
	Auth          *RelayCredentials
	MaxPorts      int
	OnlyIDs       map[string]bool
	BasePort      int
	AssignPort    func(nodeID string, index int) int
	LogPath       string
	Version       string
	OfficialApp   bool
}

// RelayCompiledOutput 保存编译生成的配置正文及端口表。
type RelayCompiledOutput struct {
	Text      string
	Endpoints map[string]RelayEndpoint
	Skipped   []RelaySkippedItem
}

func kernelBaseDirs(platform string) []string {
	if platform == "win32" || platform == "windows" {
		return []string{`C:\ProgramData\chocolatey\bin`, `C:\Program Files\sing-box`, `C:\Program Files\mihomo`}
	}
	return []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}
}

func executableExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func envLookup(env map[string]string, key string) string {
	if env != nil {
		return env[key]
	}
	return os.Getenv(key)
}

// ResolveKernelBinary 按 explicit -> managed -> PATH -> system 顺序定位内核可执行文件。
func ResolveKernelBinary(spec RelayKernelSpec, env map[string]string, aiHomeDir, platform string) *ResolvedKernelBinary {
	if platform == "" {
		platform = runtime.GOOS
	}
	normPlat := normalizeLocalPlatform(platform)
	explicit := strings.TrimSpace(ReadRelaySetting(env, spec.EnvField, ""))
	if explicit != "" {
		if executableExists(explicit) {
			return &ResolvedKernelBinary{Path: explicit, Source: "explicit"}
		}
		return nil
	}

	names := make([]string, 0, 1+len(spec.Aliases))
	allNames := append([]string{spec.ID}, spec.Aliases...)
	for _, n := range allNames {
		if normPlat == "win32" && !strings.HasSuffix(strings.ToLower(n), ".exe") {
			names = append(names, n+".exe")
		} else {
			names = append(names, n)
		}
	}

	if aiHomeDir != "" {
		for _, n := range names {
			candidate := filepath.Join(aiHomeDir, "bin", n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "managed"}
			}
		}
	}

	pathEnv := envLookup(env, "PATH")
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		for _, n := range names {
			candidate := filepath.Join(dir, n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "path"}
			}
		}
	}

	for _, dir := range kernelBaseDirs(normPlat) {
		for _, n := range names {
			candidate := filepath.Join(dir, n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "system"}
			}
		}
	}
	return nil
}

// IsLoopbackHost 判断监听地址是否为回环地址。
func IsLoopbackHost(host string) bool {
	h := strings.TrimSpace(strings.Trim(host, "[]"))
	if h == "" {
		return false
	}
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(h)
	if err != nil {
		return false
	}
	return ip.Unmap().IsLoopback()
}

func chainRefOfNode(node ProxyNode) string {
	return strings.TrimSpace(node.Str("chain"))
}

func walkRelayNodeChain(node ProxyNode, byID map[string]ProxyNode) ([]ProxyNode, string) {
	chain := make([]ProxyNode, 0, 4)
	seen := map[string]bool{}
	cursor := node
	for cursor != nil {
		id := cursor.Str("id")
		if id == "" || seen[id] {
			return nil, "invalid_proxy_chain_cycle"
		}
		seen[id] = true
		chain = append(chain, cursor)
		if len(chain) > RelayMaxChainDepth+1 {
			return nil, "invalid_proxy_chain_too_deep"
		}
		ref := chainRefOfNode(cursor)
		if ref == "" {
			break
		}
		upstream, ok := byID[ref]
		if !ok {
			return nil, "invalid_proxy_chain_missing"
		}
		cursor = upstream
	}
	return chain, ""
}

// ValidateChainRef 预演修改 nodeID 的链式前置是否会产生环、超长或缺失上游。
func ValidateChainRef(nodes []ProxyNode, nodeID, chainRef string) string {
	ref := strings.TrimSpace(chainRef)
	if ref == "" {
		return ""
	}
	if ref == nodeID {
		return "invalid_proxy_chain_cycle"
	}
	byRef := make(map[string]ProxyNode, len(nodes)*2)
	for _, n := range nodes {
		if n == nil {
			continue
		}
		id := n.Str("id")
		if id != "" {
			if _, ok := byRef[id]; !ok {
				byRef[id] = n
			}
		}
		ck := BuildProxyNodeConnectionKey(n)
		if ck != "" {
			if _, ok := byRef[ck]; !ok {
				byRef[ck] = n
			}
		}
	}
	upstream, ok := byRef[ref]
	if !ok {
		return "invalid_proxy_chain_missing"
	}
	seen := map[string]bool{nodeID: true}
	cursor := upstream
	depth := 0
	for cursor != nil {
		depth++
		if depth > RelayMaxChainDepth {
			return "invalid_proxy_chain_too_deep"
		}
		id := cursor.Str("id")
		if id == "" || seen[id] {
			return "invalid_proxy_chain_cycle"
		}
		seen[id] = true
		next := chainRefOfNode(cursor)
		if next == "" {
			break
		}
		cursor = byRef[next]
	}
	return ""
}

type relayBatchPlan struct {
	byID        map[string]ProxyNode
	wanted      []ProxyNode
	upstreamIDs map[string]bool
	skipped     []RelaySkippedItem
}

func planRelayBatch(nodes []ProxyNode, onlyIDs map[string]bool, maxPorts int) relayBatchPlan {
	if maxPorts <= 0 {
		maxPorts = RelayDefaultMaxPorts
	}
	byID := make(map[string]ProxyNode, len(nodes))
	validList := make([]ProxyNode, 0, len(nodes))
	for _, n := range nodes {
		if n == nil {
			continue
		}
		id := n.Str("id")
		if id == "" {
			continue
		}
		byID[id] = n
		validList = append(validList, n)
	}
	var skipped []RelaySkippedItem
	var wanted []ProxyNode
	for _, n := range validList {
		id := n.Str("id")
		if _, reason := walkRelayNodeChain(n, byID); reason != "" {
			if len(onlyIDs) == 0 || onlyIDs[id] {
				skipped = append(skipped, RelaySkippedItem{NodeID: id, Reason: reason})
			}
			continue
		}
		if len(onlyIDs) > 0 && !onlyIDs[id] {
			continue
		}
		wanted = append(wanted, n)
	}
	if len(wanted) > maxPorts {
		for _, extra := range wanted[maxPorts:] {
			skipped = append(skipped, RelaySkippedItem{NodeID: extra.Str("id"), Reason: "too_many_relay_nodes"})
		}
		wanted = wanted[:maxPorts]
	}
	upstreamIDs := map[string]bool{}
	pending := make([]string, 0, len(wanted))
	for _, n := range wanted {
		pending = append(pending, n.Str("id"))
	}
	for len(pending) > 0 {
		curID := pending[0]
		pending = pending[1:]
		chain, reason := walkRelayNodeChain(byID[curID], byID)
		if reason != "" {
			continue
		}
		for _, up := range chain[1:] {
			upID := up.Str("id")
			if upstreamIDs[upID] {
				continue
			}
			upstreamIDs[upID] = true
			pending = append(pending, upID)
		}
	}
	return relayBatchPlan{byID: byID, wanted: wanted, upstreamIDs: upstreamIDs, skipped: skipped}
}

func pruneRelayChainFailures(byID map[string]ProxyNode, compiled map[string]bool, endpoints map[string]RelayEndpoint, failed map[string]string, skipped *[]RelaySkippedItem) {
	changed := true
	for changed {
		changed = false
		for id := range compiled {
			up := chainRefOfNode(byID[id])
			if up != "" && !compiled[up] {
				failed[id] = "unsupported_proxy_chain_upstream_skipped"
				delete(compiled, id)
				changed = true
			}
		}
	}
	existingSkip := map[string]bool{}
	for _, s := range *skipped {
		existingSkip[s.NodeID] = true
	}
	for id, reason := range failed {
		if _, had := endpoints[id]; had {
			delete(endpoints, id)
			if !existingSkip[id] {
				existingSkip[id] = true
				*skipped = append(*skipped, RelaySkippedItem{NodeID: id, Reason: reason})
			}
		}
	}
}

func mihomoRelayProxyName(nodeID string) string {
	return mihomoRelayProxyPrefix + safeProxyNameRegex.ReplaceAllString(nodeID, "_")
}

func singBoxRelayInboundTag(nodeID string) string  { return relayInboundPrefix + nodeID }
func singBoxRelayOutboundTag(nodeID string) string { return relayOutboundPrefix + nodeID }

// CompileSingBoxRelayConfig 生成 sing-box 本机中转边车 JSON 配置与端口表。
func CompileSingBoxRelayConfig(nodes []ProxyNode, opts RelayCompileOptions) RelayCompiledOutput {
	listenHost := opts.ListenHost
	if listenHost == "" {
		listenHost = RelayDefaultListenHost
	}
	advertiseHost := opts.AdvertiseHost
	if advertiseHost == "" {
		advertiseHost = listenHost
	}
	maxPorts := opts.MaxPorts
	if maxPorts <= 0 {
		maxPorts = RelayDefaultMaxPorts
	}
	basePort := opts.BasePort
	if basePort <= 0 {
		basePort = SingBoxRelayBasePort
	}
	batch := planRelayBatch(nodes, opts.OnlyIDs, maxPorts)
	sort.Slice(batch.wanted, func(i, j int) bool {
		return batch.wanted[i].Str("id") < batch.wanted[j].Str("id")
	})

	endpoints := make(map[string]RelayEndpoint, len(batch.wanted))
	orderedIDs := make([]string, 0, len(batch.wanted))
	for idx, n := range batch.wanted {
		id := n.Str("id")
		orderedIDs = append(orderedIDs, id)
		p := basePort + idx
		if opts.AssignPort != nil {
			p = opts.AssignPort(id, idx)
		}
		endpoints[id] = RelayEndpoint{
			Host: advertiseHost,
			Port: p,
			UDP:  SupportsUDPRelay(n),
		}
	}

	seenOutID := map[string]bool{}
	var outboundIDs []string
	for _, id := range orderedIDs {
		if _, ok := batch.byID[id]; ok && !seenOutID[id] {
			seenOutID[id] = true
			outboundIDs = append(outboundIDs, id)
		}
	}
	for id := range batch.upstreamIDs {
		if _, ok := batch.byID[id]; ok && !seenOutID[id] {
			seenOutID[id] = true
			outboundIDs = append(outboundIDs, id)
		}
	}
	sort.Strings(outboundIDs[len(orderedIDs):])

	compiled := make(map[string]SingBoxCompiled, len(outboundIDs))
	compiledFlags := make(map[string]bool, len(outboundIDs))
	failed := make(map[string]string)
	for _, id := range outboundIDs {
		res, err := CompileSingBoxOutbound(batch.byID[id], singBoxRelayOutboundTag(id), opts.Version, opts.OfficialApp)
		if err != nil {
			failed[id] = errorCodeOf(err)
			continue
		}
		compiled[id] = res
		compiledFlags[id] = true
	}
	skipped := append([]RelaySkippedItem(nil), batch.skipped...)
	pruneRelayChainFailures(batch.byID, compiledFlags, endpoints, failed, &skipped)

	inbounds := make([]*YAMLMap, 0, len(endpoints))
	rules := make([]*YAMLMap, 0, len(endpoints))
	for _, id := range orderedIDs {
		ep, ok := endpoints[id]
		if !ok {
			continue
		}
		inb := &YAMLMap{}
		inb.Set("type", "mixed")
		inb.Set("tag", singBoxRelayInboundTag(id))
		inb.Set("listen", listenHost)
		inb.Set("listen_port", ep.Port)
		if opts.Auth != nil && opts.Auth.Username != "" {
			u := &YAMLMap{}
			u.Set("username", opts.Auth.Username)
			u.Set("password", opts.Auth.Password)
			inb.Set("users", []*YAMLMap{u})
		}
		inbounds = append(inbounds, inb)

		rule := &YAMLMap{}
		rule.Set("inbound", []string{singBoxRelayInboundTag(id)})
		rule.Set("outbound", singBoxRelayOutboundTag(id))
		rules = append(rules, rule)
	}

	var outbounds []*YAMLMap
	var endpointsSection []*YAMLMap
	for _, id := range outboundIDs {
		if !compiledFlags[id] {
			continue
		}
		c := compiled[id]
		if up := chainRefOfNode(batch.byID[id]); up != "" && compiledFlags[up] {
			c.Item.Set("detour", singBoxRelayOutboundTag(up))
		}
		if c.IsEndpoint {
			endpointsSection = append(endpointsSection, c.Item)
		} else {
			outbounds = append(outbounds, c.Item)
		}
		outbounds = append(outbounds, c.Extras...)
	}
	directOut := &YAMLMap{}
	directOut.Set("type", "direct")
	directOut.Set("tag", relayDirectTag)
	outbounds = append(outbounds, directOut)

	logMap := &YAMLMap{}
	logMap.Set("level", "warn")
	logMap.Set("timestamp", true)
	if opts.LogPath != "" {
		logMap.Set("output", opts.LogPath)
	}

	routeMap := &YAMLMap{}
	routeMap.Set("rules", rules)
	routeMap.Set("final", relayDirectTag)

	cfg := &YAMLMap{}
	cfg.Set("log", logMap)
	cfg.Set("inbounds", inbounds)
	cfg.Set("outbounds", outbounds)
	if len(endpointsSection) > 0 {
		cfg.Set("endpoints", endpointsSection)
	}
	cfg.Set("route", routeMap)

	text := string(yamlMapToOrderedJSON(cfg, "")) + "\n"
	return RelayCompiledOutput{Text: text, Endpoints: endpoints, Skipped: skipped}
}

// CompileMihomoRelayConfigText 生成 mihomo 本机中转边车 YAML 配置与端口表。
func CompileMihomoRelayConfigText(nodes []ProxyNode, opts RelayCompileOptions) RelayCompiledOutput {
	listenHost := opts.ListenHost
	if listenHost == "" {
		listenHost = RelayDefaultListenHost
	}
	advertiseHost := opts.AdvertiseHost
	if advertiseHost == "" {
		advertiseHost = listenHost
	}
	maxPorts := opts.MaxPorts
	if maxPorts <= 0 {
		maxPorts = RelayDefaultMaxPorts
	}
	basePort := opts.BasePort
	if basePort <= 0 {
		basePort = MihomoRelayBasePort
	}
	batch := planRelayBatch(nodes, opts.OnlyIDs, maxPorts)
	sort.Slice(batch.wanted, func(i, j int) bool {
		return batch.wanted[i].Str("id") < batch.wanted[j].Str("id")
	})

	endpoints := make(map[string]RelayEndpoint, len(batch.wanted))
	orderedIDs := make([]string, 0, len(batch.wanted))
	for idx, n := range batch.wanted {
		id := n.Str("id")
		orderedIDs = append(orderedIDs, id)
		p := basePort + idx
		if opts.AssignPort != nil {
			p = opts.AssignPort(id, idx)
		}
		endpoints[id] = RelayEndpoint{
			Host: advertiseHost,
			Port: p,
			UDP:  SupportsUDPRelay(n),
		}
	}

	seenOutID := map[string]bool{}
	var outboundIDs []string
	for _, id := range orderedIDs {
		if _, ok := batch.byID[id]; ok && !seenOutID[id] {
			seenOutID[id] = true
			outboundIDs = append(outboundIDs, id)
		}
	}
	for id := range batch.upstreamIDs {
		if _, ok := batch.byID[id]; ok && !seenOutID[id] {
			seenOutID[id] = true
			outboundIDs = append(outboundIDs, id)
		}
	}

	compiled := make(map[string]*YAMLMap, len(outboundIDs))
	compiledFlags := make(map[string]bool, len(outboundIDs))
	failed := make(map[string]string)
	for _, id := range outboundIDs {
		m, err := CompileMihomoProxy(batch.byID[id], mihomoRelayProxyName(id), "mihomo")
		if err != nil {
			failed[id] = errorCodeOf(err)
			continue
		}
		compiled[id] = m
		compiledFlags[id] = true
	}
	skipped := append([]RelaySkippedItem(nil), batch.skipped...)
	pruneRelayChainFailures(batch.byID, compiledFlags, endpoints, failed, &skipped)

	proxies := make([]*YAMLMap, 0, len(compiled))
	for _, id := range outboundIDs {
		if !compiledFlags[id] {
			continue
		}
		m := compiled[id]
		if up := chainRefOfNode(batch.byID[id]); up != "" && compiledFlags[up] {
			m.Set("dialer-proxy", mihomoRelayProxyName(up))
		}
		proxies = append(proxies, m)
	}

	listeners := make([]*YAMLMap, 0, len(endpoints))
	for _, id := range orderedIDs {
		ep, ok := endpoints[id]
		if !ok {
			continue
		}
		l := &YAMLMap{}
		l.Set("name", singBoxRelayInboundTag(id))
		l.Set("type", "mixed")
		l.Set("listen", listenHost)
		l.Set("port", ep.Port)
		l.Set("proxy", mihomoRelayProxyName(id))
		if opts.Auth != nil && opts.Auth.Username != "" {
			u := &YAMLMap{}
			u.Set("username", opts.Auth.Username)
			u.Set("password", opts.Auth.Password)
			l.Set("users", []*YAMLMap{u})
		}
		listeners = append(listeners, l)
	}

	cfg := &YAMLMap{}
	cfg.Set("log-level", "warning")
	cfg.Set("mode", "global")
	cfg.Set("proxies", proxies)
	cfg.Set("listeners", listeners)

	return RelayCompiledOutput{
		Text:      EmitYAML(cfg) + "\n",
		Endpoints: endpoints,
		Skipped:   skipped,
	}
}

var (
	singBoxKernelSpec = RelayKernelSpec{
		ID:                      "sing-box",
		Label:                   "sing-box",
		EnvField:                "singBoxBin",
		ConfigFileName:          "sing-box.json",
		BasePort:                SingBoxRelayBasePort,
		MaxPorts:                RelayDefaultMaxPorts,
		VersionArgs:             []string{"version"},
		BuildDependentProtocols: []string{"naive"},
		ParseVersion: func(stdout string) string {
			m := singBoxVerOutRegex.FindStringSubmatch(stdout)
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		},
		CheckArgs: func(configFile, _ string) []string {
			return []string{"check", "-c", configFile}
		},
		RunArgs: func(configFile, _ string) []string {
			return []string{"run", "-c", configFile}
		},
		CanCompileNode: func(node ProxyNode, version string) bool {
			_, err := CompileSingBoxOutbound(node, "relay-probe", version, true)
			return err == nil
		},
		CompileText: func(nodes []ProxyNode, opts RelayCompileOptions) RelayCompiledOutput {
			return CompileSingBoxRelayConfig(nodes, opts)
		},
	}

	mihomoKernelSpec = RelayKernelSpec{
		ID:                      "mihomo",
		Label:                   "mihomo",
		EnvField:                "mihomoBin",
		Aliases:                 []string{"verge-mihomo-alpha", "clash-meta", "clash.meta"},
		ConfigFileName:          "mihomo.yaml",
		BasePort:                MihomoRelayBasePort,
		MaxPorts:                RelayDefaultMaxPorts,
		VersionArgs:             []string{"-v"},
		BuildDependentProtocols: []string{},
		ParseVersion: func(stdout string) string {
			m := mihomoVerOutRegex.FindStringSubmatch(stdout)
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		},
		CheckArgs: func(configFile, runDir string) []string {
			return []string{"-t", "-d", runDir, "-f", configFile}
		},
		RunArgs: func(configFile, runDir string) []string {
			return []string{"-d", runDir, "-f", configFile}
		},
		CanCompileNode: func(node ProxyNode, _ string) bool {
			_, err := CompileMihomoProxy(node, "relay-probe", "mihomo")
			return err == nil
		},
		CompileText: func(nodes []ProxyNode, opts RelayCompileOptions) RelayCompiledOutput {
			return CompileMihomoRelayConfigText(nodes, opts)
		},
	}
)

// RelayKernelStatus 描述单个中转内核在系统中的状态。
type RelayKernelStatus struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	EnvField     string `json:"envField"`
	BasePort     int    `json:"basePort"`
	MaxPorts     int    `json:"maxPorts"`
	PortRange    string `json:"portRange"`
	ListenHost   string `json:"listenHost"`
	AuthRequired bool   `json:"authRequired"`
	Running      bool   `json:"running"`
	Nodes        int    `json:"nodes"`
	Available    bool   `json:"available"`
	Binary       string `json:"binary"`
	Source       string `json:"source"`
	Version      string `json:"version"`
	Error        string `json:"error"`
}

// RelayAvailability 描述整个本机中转子系统的可用状态。
type RelayAvailability struct {
	Available    bool                `json:"available"`
	Binary       string              `json:"binary"`
	Source       string              `json:"source"`
	Version      string              `json:"version"`
	Running      bool                `json:"running"`
	Nodes        int                 `json:"nodes"`
	BasePort     int                 `json:"basePort"`
	MaxPort      int                 `json:"maxPort"`
	PortRange    string              `json:"portRange"`
	PortMode     string              `json:"portMode"`
	ListenHost   string              `json:"listenHost"`
	AuthRequired bool                `json:"authRequired"`
	Kernels      []RelayKernelStatus `json:"kernels"`
	Error        string              `json:"error"`
}

// RelayEnsureResult 描述拉起或复用边车进程的结果。
type RelayEnsureResult struct {
	OK        bool
	Endpoints map[string]RelayEndpoint
	Skipped   []RelaySkippedItem
	Error     string
	Detail    string
}

type sidecarRunningState struct {
	key        string
	endpoints  map[string]RelayEndpoint
	configFile string
	logFile    string
	listenHost string
	hasAuth    bool
}

// KernelSidecar 管理单个中转内核的子进程生命周期、配置校验与端口映射。
type KernelSidecar struct {
	kernel     RelayKernelSpec
	aiHomeDir  string
	runDir     string
	env        map[string]string
	platform   string
	listenHost string

	mu         sync.Mutex
	exposed    bool
	auth       *RelayCredentials
	portByNode map[string]int
	binary     *ResolvedKernelBinary
	cmd        *exec.Cmd
	exitedCh   chan struct{}
	current    *sidecarRunningState
	inFlight   chan struct{}
	lastEnsure RelayEnsureResult
}

func newKernelSidecar(kernel RelayKernelSpec, aiHomeDir, runDir string, env map[string]string) *KernelSidecar {
	return &KernelSidecar{
		kernel:     kernel,
		aiHomeDir:  aiHomeDir,
		runDir:     runDir,
		env:        env,
		platform:   runtime.GOOS,
		listenHost: strings.TrimSpace(ReadRelaySetting(env, "listenHost", "")),
		portByNode: make(map[string]int),
	}
}

func (s *KernelSidecar) resolveBinaryLocked() *ResolvedKernelBinary {
	if s.binary != nil {
		return s.binary
	}
	res := ResolveKernelBinary(s.kernel, s.env, s.aiHomeDir, s.platform)
	if res == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), relayVersionProbeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, res.Path, s.kernel.VersionArgs...).Output()
	if err == nil && s.kernel.ParseVersion != nil {
		res.Version = s.kernel.ParseVersion(string(out))
	}
	s.binary = res
	return res
}

func (s *KernelSidecar) isRunningLocked() bool {
	if s.cmd == nil || s.exitedCh == nil {
		return false
	}
	select {
	case <-s.exitedCh:
		return false
	default:
		return true
	}
}

func (s *KernelSidecar) Availability() RelayKernelStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	bin := s.resolveBinaryLocked()
	running := s.isRunningLocked()
	status := RelayKernelStatus{
		ID:        s.kernel.ID,
		Label:     s.kernel.Label,
		EnvField:  s.kernel.EnvField,
		BasePort:  s.kernel.BasePort,
		MaxPorts:  s.kernel.MaxPorts,
		PortRange: fmt.Sprintf("%d-%d", s.kernel.BasePort, s.kernel.BasePort+s.kernel.MaxPorts-1),
		Running:   running,
	}
	if running && s.current != nil {
		status.ListenHost = s.current.listenHost
		status.AuthRequired = s.current.hasAuth
		status.Nodes = len(s.current.endpoints)
	}
	if bin == nil {
		status.Available = false
		status.Error = "relay_binary_not_found"
		return status
	}
	status.Available = true
	status.Binary = bin.Path
	status.Source = bin.Source
	status.Version = bin.Version
	return status
}

func (s *KernelSidecar) ActiveEndpoints() map[string]RelayEndpoint {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isRunningLocked() || s.current == nil {
		return map[string]RelayEndpoint{}
	}
	cp := make(map[string]RelayEndpoint, len(s.current.endpoints))
	for k, v := range s.current.endpoints {
		cp[k] = v
	}
	return cp
}

func (s *KernelSidecar) ActiveListenHost() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isRunningLocked() || s.current == nil {
		return ""
	}
	return s.current.listenHost
}

func (s *KernelSidecar) Stop() {
	s.mu.Lock()
	cmd := s.cmd
	exitedCh := s.exitedCh
	s.cmd = nil
	s.exitedCh = nil
	s.current = nil
	s.mu.Unlock()
	killProcessWithGrace(cmd, exitedCh)
}

func killProcessWithGrace(cmd *exec.Cmd, exitedCh <-chan struct{}) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	timer := time.NewTimer(relayStopGrace)
	defer timer.Stop()
	if exitedCh != nil {
		select {
		case <-exitedCh:
			return
		case <-timer.C:
		}
	} else {
		<-timer.C
	}
	_ = cmd.Process.Kill()
	if exitedCh != nil {
		<-exitedCh
	}
}

func relayKeyForBatch(kernelID string, nodes []ProxyNode, onlyIDs map[string]bool, listenHost string, auth *RelayCredentials) string {
	var ids []string
	if len(onlyIDs) > 0 {
		ids = make([]string, 0, len(onlyIDs))
		for id := range onlyIDs {
			ids = append(ids, id)
		}
		sort.Strings(ids)
	}
	nodeTuples := make([][]any, 0, len(nodes))
	for _, n := range nodes {
		p, _ := n.Int("port")
		nodeTuples = append(nodeTuples, []any{n.Str("id"), n.Str("protocol"), n.Str("server"), p, n.Str("chain")})
	}
	sort.Slice(nodeTuples, func(i, j int) bool {
		return toString(nodeTuples[i][0]) < toString(nodeTuples[j][0])
	})
	authUser := ""
	if auth != nil {
		authUser = auth.Username
	}
	raw, _ := json.Marshal([]any{kernelID, nodeTuples, ids, listenHost, authUser})
	return string(raw)
}

func (s *KernelSidecar) effectiveListenHostLocked() string {
	if s.listenHost != "" {
		return s.listenHost
	}
	if s.exposed {
		return "0.0.0.0"
	}
	return "127.0.0.1"
}

func isTCPPortFree(host string, port int) bool {
	ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func (s *KernelSidecar) resolvePorts(order []string, listenHost string, remembered map[string]int) []int {
	taken := map[int]bool{}
	ports := make([]int, len(order))
	for i, id := range order {
		if r := remembered[id]; r > 0 && !taken[r] && isTCPPortFree(listenHost, r) {
			ports[i] = r
			taken[r] = true
		}
	}
	candidate := s.kernel.BasePort
	ceiling := s.kernel.BasePort + len(order) + relayPortProbeWindow
	for i := range order {
		if ports[i] > 0 {
			continue
		}
		for candidate < ceiling && (taken[candidate] || !isTCPPortFree(listenHost, candidate)) {
			candidate++
		}
		if candidate >= ceiling {
			return nil
		}
		ports[i] = candidate
		taken[candidate] = true
		candidate++
	}
	return ports
}

func tailString(text string, limit int) string {
	t := strings.TrimSpace(text)
	if len(t) <= limit {
		return t
	}
	return t[len(t)-limit:]
}

func (s *KernelSidecar) waitSidecarReady(ctx context.Context, cmd *exec.Cmd, exitedCh <-chan struct{}, ports []int, listenHost string) error {
	dialHost := listenHost
	if dialHost == "" || dialHost == "0.0.0.0" {
		dialHost = "127.0.0.1"
	}
	deadline := time.Now().Add(relayReadinessTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-exitedCh:
			return errInvalid("relay_process_exited")
		case <-ctx.Done():
			return errInvalid("relay_readiness_timeout")
		default:
		}
		allUp := true
		for _, p := range ports {
			d := &net.Dialer{Timeout: 500 * time.Millisecond}
			c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(dialHost, strconv.Itoa(p)))
			if err != nil {
				allUp = false
				break
			}
			_ = c.Close()
		}
		if allUp {
			return nil
		}
		time.Sleep(80 * time.Millisecond)
	}
	return errInvalid("relay_readiness_timeout")
}

// Ensure 确保边车按指定节点列表运行，并在配置变更时原子重启。
func (s *KernelSidecar) Ensure(ctx context.Context, nodes []ProxyNode, onlyIDs map[string]bool, remote bool, auth *RelayCredentials) RelayEnsureResult {
	for {
		s.mu.Lock()
		bin := s.resolveBinaryLocked()
		if bin == nil {
			s.mu.Unlock()
			return RelayEnsureResult{OK: false, Error: "relay_binary_not_found", Endpoints: map[string]RelayEndpoint{}}
		}
		if remote {
			s.exposed = true
		}
		if auth != nil {
			s.auth = auth
		}
		listenHost := s.effectiveListenHostLocked()
		var activeAuth *RelayCredentials
		if !IsLoopbackHost(listenHost) {
			activeAuth = s.auth
			if activeAuth == nil {
				s.mu.Unlock()
				return RelayEnsureResult{OK: false, Error: "relay_auth_required", Endpoints: map[string]RelayEndpoint{}}
			}
		}
		wanted := make([]ProxyNode, 0, len(nodes))
		for _, n := range nodes {
			if n != nil && n.Str("id") != "" {
				wanted = append(wanted, n)
			}
		}
		if len(wanted) == 0 {
			s.mu.Unlock()
			return RelayEnsureResult{OK: true, Endpoints: map[string]RelayEndpoint{}}
		}

		shape := s.kernel.CompileText(wanted, RelayCompileOptions{
			ListenHost:  listenHost,
			Auth:        activeAuth,
			MaxPorts:    s.kernel.MaxPorts,
			OnlyIDs:     onlyIDs,
			BasePort:    s.kernel.BasePort,
			Version:     bin.Version,
			OfficialApp: true,
			AssignPort:  func(string, int) int { return 0 },
		})
		if len(shape.Endpoints) == 0 {
			s.mu.Unlock()
			return RelayEnsureResult{OK: true, Endpoints: map[string]RelayEndpoint{}, Skipped: shape.Skipped}
		}
		key := relayKeyForBatch(s.kernel.ID, wanted, onlyIDs, listenHost, activeAuth)
		if s.isRunningLocked() && s.current != nil && s.current.key == key {
			cp := make(map[string]RelayEndpoint, len(s.current.endpoints))
			for k, v := range s.current.endpoints {
				cp[k] = v
			}
			s.mu.Unlock()
			return RelayEnsureResult{OK: true, Endpoints: cp, Skipped: shape.Skipped}
		}
		if s.inFlight != nil {
			ch := s.inFlight
			s.mu.Unlock()
			<-ch
			s.mu.Lock()
			res := s.lastEnsure
			s.mu.Unlock()
			return res
		}
		ch := make(chan struct{})
		s.inFlight = ch
		remembered := make(map[string]int, len(s.portByNode))
		for k, v := range s.portByNode {
			remembered[k] = v
		}
		s.mu.Unlock()

		res := s.restart(ctx, *bin, wanted, key, listenHost, activeAuth, onlyIDs, remembered)
		s.mu.Lock()
		s.lastEnsure = res
		s.inFlight = nil
		close(ch)
		s.mu.Unlock()
		return res
	}
}

func (s *KernelSidecar) restart(ctx context.Context, bin ResolvedKernelBinary, wanted []ProxyNode, key, listenHost string, auth *RelayCredentials, onlyIDs map[string]bool, remembered map[string]int) RelayEnsureResult {
	s.Stop()
	nodes := wanted
	var droppedSkipped []RelaySkippedItem

	for round := 0; round < 2; round++ {
		shape := s.kernel.CompileText(nodes, RelayCompileOptions{
			ListenHost:  listenHost,
			Auth:        auth,
			MaxPorts:    s.kernel.MaxPorts,
			OnlyIDs:     onlyIDs,
			BasePort:    s.kernel.BasePort,
			Version:     bin.Version,
			OfficialApp: true,
			AssignPort:  func(string, int) int { return 0 },
		})
		if len(shape.Endpoints) == 0 {
			return RelayEnsureResult{OK: true, Endpoints: map[string]RelayEndpoint{}, Skipped: append(droppedSkipped, shape.Skipped...)}
		}
		order := make([]string, 0, len(shape.Endpoints))
		for id := range shape.Endpoints {
			order = append(order, id)
		}
		sort.Strings(order)
		ports := s.resolvePorts(order, listenHost, remembered)
		if ports == nil {
			return RelayEnsureResult{OK: false, Error: "relay_port_unavailable", Endpoints: map[string]RelayEndpoint{}, Skipped: shape.Skipped}
		}
		portByNode := make(map[string]int, len(order))
		for i, id := range order {
			portByNode[id] = ports[i]
		}
		if err := os.MkdirAll(s.runDir, 0o700); err != nil {
			return RelayEnsureResult{OK: false, Error: "relay_spawn_failed", Detail: err.Error(), Endpoints: map[string]RelayEndpoint{}}
		}
		configFile := filepath.Join(s.runDir, s.kernel.ConfigFileName)
		logFile := filepath.Join(s.runDir, s.kernel.ID+".log")

		compiled := s.kernel.CompileText(nodes, RelayCompileOptions{
			ListenHost:  listenHost,
			Auth:        auth,
			MaxPorts:    s.kernel.MaxPorts,
			OnlyIDs:     onlyIDs,
			BasePort:    s.kernel.BasePort,
			Version:     bin.Version,
			OfficialApp: true,
			LogPath:     logFile,
			AssignPort: func(nodeID string, _ int) int {
				return portByNode[nodeID]
			},
		})
		if len(compiled.Endpoints) == 0 {
			return RelayEnsureResult{OK: true, Endpoints: map[string]RelayEndpoint{}, Skipped: append(droppedSkipped, compiled.Skipped...)}
		}
		for id, ep := range compiled.Endpoints {
			if ep.Port != portByNode[id] {
				return RelayEnsureResult{OK: false, Error: "relay_port_mismatch", Endpoints: map[string]RelayEndpoint{}, Skipped: compiled.Skipped}
			}
		}
		if err := writeFileAtomic0600(configFile, []byte(compiled.Text)); err != nil {
			return RelayEnsureResult{OK: false, Error: "relay_spawn_failed", Detail: err.Error(), Endpoints: map[string]RelayEndpoint{}}
		}
		chkCtx, chkCancel := context.WithTimeout(ctx, relayCheckTimeout)
		chkCmd := exec.CommandContext(chkCtx, bin.Path, s.kernel.CheckArgs(configFile, s.runDir)...)
		chkCmd.Dir = s.runDir
		chkOut, chkErr := chkCmd.CombinedOutput()
		chkCancel()
		if chkErr != nil {
			detail := tailString(string(chkOut), 500)
			if detail == "" {
				detail = chkErr.Error()
			}
			var nextNodes []ProxyNode
			var droppable []ProxyNode
			if round == 0 && len(s.kernel.BuildDependentProtocols) > 0 {
				depSet := map[string]bool{}
				for _, dp := range s.kernel.BuildDependentProtocols {
					depSet[dp] = true
				}
				for _, n := range nodes {
					if depSet[strings.ToLower(n.Str("protocol"))] {
						droppable = append(droppable, n)
					} else {
						nextNodes = append(nextNodes, n)
					}
				}
			}
			if len(droppable) == 0 {
				return RelayEnsureResult{OK: false, Error: "relay_config_rejected", Detail: detail, Endpoints: map[string]RelayEndpoint{}, Skipped: compiled.Skipped}
			}
			for _, dn := range droppable {
				droppedSkipped = append(droppedSkipped, RelaySkippedItem{
					NodeID: dn.Str("id"),
					Reason: "relay_kernel_unsupported_" + strings.ToLower(dn.Str("protocol")),
				})
			}
			nodes = nextNodes
			continue
		}

		// 配置检查通过：启动并等待监听端口就绪。
		lf, lErr := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if lErr != nil {
			return RelayEnsureResult{OK: false, Error: "relay_spawn_failed", Detail: lErr.Error(), Endpoints: map[string]RelayEndpoint{}, Skipped: compiled.Skipped}
		}
		runCmd := exec.Command(bin.Path, s.kernel.RunArgs(configFile, s.runDir)...)
		runCmd.Dir = s.runDir
		runCmd.Stdout = lf
		runCmd.Stderr = lf
		if startErr := runCmd.Start(); startErr != nil {
			_ = lf.Close()
			return RelayEnsureResult{OK: false, Error: "relay_spawn_failed", Detail: tailString(startErr.Error(), 500), Endpoints: map[string]RelayEndpoint{}, Skipped: compiled.Skipped}
		}
		_ = lf.Close()
		exitedCh := make(chan struct{})
		go func(c *exec.Cmd, ch chan struct{}) {
			_ = c.Wait()
			close(ch)
		}(runCmd, exitedCh)

		if wErr := s.waitSidecarReady(ctx, runCmd, exitedCh, ports, listenHost); wErr != nil {
			killProcessWithGrace(runCmd, exitedCh)
			logTail := ""
			if rawLog, rErr := os.ReadFile(logFile); rErr == nil {
				logTail = tailString(string(rawLog), 500)
			}
			return RelayEnsureResult{OK: false, Error: errorCodeOf(wErr), Detail: logTail, Endpoints: map[string]RelayEndpoint{}, Skipped: compiled.Skipped}
		}

		endpointsOut := make(map[string]RelayEndpoint, len(compiled.Endpoints))
		for id, ep := range compiled.Endpoints {
			if auth != nil {
				ep.Username = auth.Username
				ep.Password = auth.Password
			}
			endpointsOut[id] = ep
		}

		s.mu.Lock()
		s.cmd = runCmd
		s.exitedCh = exitedCh
		s.portByNode = portByNode
		s.current = &sidecarRunningState{
			key:        key,
			endpoints:  endpointsOut,
			configFile: configFile,
			logFile:    logFile,
			listenHost: listenHost,
			hasAuth:    auth != nil,
		}
		s.mu.Unlock()

		return RelayEnsureResult{
			OK:        true,
			Endpoints: endpointsOut,
			Skipped:   append(droppedSkipped, compiled.Skipped...),
		}
	}
	return RelayEnsureResult{OK: false, Error: "relay_config_rejected", Endpoints: map[string]RelayEndpoint{}, Skipped: droppedSkipped}
}

// LocalRelay 管理 sing-box 与 mihomo 双内核边车并统一暴露本地中转能力。
type LocalRelay struct {
	aiHomeDir   string
	runDir      string
	env         map[string]string
	sidecars    map[string]*KernelSidecar
	kernelOrder []RelayKernelSpec

	mu          sync.Mutex
	exposed     bool
	credentials *RelayCredentials
	udpEndpoint *RelayEndpoint
}

// NewLocalRelay 构造本机中转控制器（构造时不拉起任何子进程）。
func NewLocalRelay(aiHomeDir string, env map[string]string) *LocalRelay {
	runDir := filepath.Join(aiHomeDir, "run", "subscription-relay")
	specs := []RelayKernelSpec{singBoxKernelSpec, mihomoKernelSpec}
	sidecars := make(map[string]*KernelSidecar, len(specs))
	for _, spec := range specs {
		sidecars[spec.ID] = newKernelSidecar(spec, aiHomeDir, filepath.Join(runDir, spec.ID), env)
	}
	return &LocalRelay{
		aiHomeDir:   aiHomeDir,
		runDir:      runDir,
		env:         env,
		sidecars:    sidecars,
		kernelOrder: specs,
	}
}

func (r *LocalRelay) PortMode() string {
	mode := strings.ToLower(strings.TrimSpace(ReadRelaySetting(r.env, "portMode", "server")))
	if mode == "dedicated" {
		return "dedicated"
	}
	return "server"
}

func (r *LocalRelay) ServerPortMode() bool {
	return r.PortMode() == "server"
}

func (r *LocalRelay) Credentials() (RelayCredentials, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.credentials != nil {
		return *r.credentials, nil
	}
	creds, err := ResolveRelayCredentials(r.runDir)
	if err != nil {
		return RelayCredentials{}, err
	}
	r.credentials = &creds
	return creds, nil
}

func (r *LocalRelay) AttachUDPEndpoint(ep *RelayEndpoint) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if ep != nil && ep.Port > 0 {
		cp := *ep
		r.udpEndpoint = &cp
	} else {
		r.udpEndpoint = nil
	}
}

func (r *LocalRelay) UDPEndpoint() *RelayEndpoint {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.udpEndpoint == nil {
		return nil
	}
	cp := *r.udpEndpoint
	return &cp
}

func (r *LocalRelay) ActiveEndpoints() map[string]RelayEndpoint {
	merged := map[string]RelayEndpoint{}
	for _, spec := range r.kernelOrder {
		for k, v := range r.sidecars[spec.ID].ActiveEndpoints() {
			merged[k] = v
		}
	}
	return merged
}

func (r *LocalRelay) ActiveListenHost() string {
	for _, spec := range r.kernelOrder {
		if host := r.sidecars[spec.ID].ActiveListenHost(); host != "" {
			return host
		}
	}
	return ""
}

func (r *LocalRelay) Availability() RelayAvailability {
	kernels := make([]RelayKernelStatus, 0, len(r.kernelOrder))
	var available []RelayKernelStatus
	var running []RelayKernelStatus
	basePort := 0
	maxPort := 0
	totalNodes := 0
	listenHost := ""
	authReq := false

	for _, spec := range r.kernelOrder {
		st := r.sidecars[spec.ID].Availability()
		kernels = append(kernels, st)
		if basePort == 0 || st.BasePort < basePort {
			basePort = st.BasePort
		}
		if end := st.BasePort + st.MaxPorts - 1; end > maxPort {
			maxPort = end
		}
		if st.Available {
			available = append(available, st)
		}
		if st.Running {
			running = append(running, st)
			totalNodes += st.Nodes
			if listenHost == "" && st.ListenHost != "" {
				listenHost = st.ListenHost
			}
			if st.AuthRequired {
				authReq = true
			}
		}
	}
	preferred := kernels[0]
	if len(available) > 0 {
		preferred = available[0]
	}
	errCode := ""
	if len(available) == 0 {
		errCode = "relay_binary_not_found"
	}
	return RelayAvailability{
		Available:    len(available) > 0,
		Binary:       preferred.Binary,
		Source:       preferred.Source,
		Version:      preferred.Version,
		Running:      len(running) > 0,
		Nodes:        totalNodes,
		BasePort:     basePort,
		MaxPort:      maxPort,
		PortRange:    fmt.Sprintf("%d-%d", basePort, maxPort),
		PortMode:     r.PortMode(),
		ListenHost:   listenHost,
		AuthRequired: authReq,
		Kernels:      kernels,
		Error:        errCode,
	}
}

func (r *LocalRelay) splitNodesByKernel(nodes []ProxyNode) []struct {
	spec  RelayKernelSpec
	nodes []ProxyNode
} {
	byID := map[string]ProxyNode{}
	valid := make([]ProxyNode, 0, len(nodes))
	for _, n := range nodes {
		if n != nil && n.Str("id") != "" {
			byID[n.Str("id")] = n
			valid = append(valid, n)
		}
	}
	chainGroups := map[string]map[string]ProxyNode{}
	var rootOrder []string
	for _, n := range valid {
		chain, reason := walkRelayNodeChain(n, byID)
		if reason != "" {
			chain = []ProxyNode{n}
		}
		root := chain[len(chain)-1].Str("id")
		if _, ok := chainGroups[root]; !ok {
			chainGroups[root] = map[string]ProxyNode{}
			rootOrder = append(rootOrder, root)
		}
		for _, m := range chain {
			chainGroups[root][m.Str("id")] = m
		}
	}

	perKernel := make(map[string]map[string]ProxyNode, len(r.kernelOrder))
	for _, spec := range r.kernelOrder {
		perKernel[spec.ID] = map[string]ProxyNode{}
	}
	for _, root := range rootOrder {
		members := make([]ProxyNode, 0, len(chainGroups[root]))
		for _, m := range chainGroups[root] {
			members = append(members, m)
		}
		chosen := r.kernelOrder[0]
		for _, spec := range r.kernelOrder {
			ver := ""
			if st := r.sidecars[spec.ID].Availability(); st.Available {
				ver = st.Version
			}
			okAll := true
			for _, m := range members {
				if !spec.CanCompileNode(m, ver) {
					okAll = false
					break
				}
			}
			if okAll {
				chosen = spec
				break
			}
		}
		for _, m := range members {
			perKernel[chosen.ID][m.Str("id")] = m
		}
	}

	var groups []struct {
		spec  RelayKernelSpec
		nodes []ProxyNode
	}
	for _, spec := range r.kernelOrder {
		if len(perKernel[spec.ID]) == 0 {
			continue
		}
		list := make([]ProxyNode, 0, len(perKernel[spec.ID]))
		for _, m := range perKernel[spec.ID] {
			list = append(list, m)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Str("id") < list[j].Str("id") })
		groups = append(groups, struct {
			spec  RelayKernelSpec
			nodes []ProxyNode
		}{spec: spec, nodes: list})
	}
	return groups
}

// Ensure 确保需要的内核边车处于运行状态并返回节点代理入口映射。
func (r *LocalRelay) Ensure(ctx context.Context, nodes []ProxyNode, onlyIDs map[string]bool, remoteReq bool) RelayEnsureResult {
	remote := remoteReq && !r.ServerPortMode()
	var auth *RelayCredentials
	r.mu.Lock()
	if remote {
		r.exposed = true
	}
	isExposed := r.exposed
	r.mu.Unlock()
	if isExposed {
		if creds, err := r.Credentials(); err == nil {
			auth = &creds
		}
	}
	groups := r.splitNodesByKernel(nodes)
	if len(groups) == 0 {
		return RelayEnsureResult{OK: true, Endpoints: map[string]RelayEndpoint{}}
	}

	results := make([]RelayEnsureResult, len(groups))
	var wg sync.WaitGroup
	for i, g := range groups {
		wg.Add(1)
		go func(idx int, spec RelayKernelSpec, list []ProxyNode) {
			defer wg.Done()
			results[idx] = r.sidecars[spec.ID].Ensure(ctx, list, onlyIDs, remote, auth)
		}(i, g.spec, g.nodes)
	}
	wg.Wait()

	merged := map[string]RelayEndpoint{}
	var skipped []RelaySkippedItem
	var firstErr, firstDetail string
	for _, res := range results {
		for k, v := range res.Endpoints {
			merged[k] = v
		}
		skipped = append(skipped, res.Skipped...)
		if !res.OK && firstErr == "" {
			firstErr = res.Error
			if firstErr == "" {
				firstErr = "relay_failed"
			}
			firstDetail = res.Detail
		}
	}
	return RelayEnsureResult{
		OK:        len(merged) > 0 || firstErr == "",
		Endpoints: merged,
		Skipped:   skipped,
		Error:     firstErr,
		Detail:    firstDetail,
	}
}

// Stop 停掉所有内核边车进程。
func (r *LocalRelay) Stop() {
	var wg sync.WaitGroup
	for _, sc := range r.sidecars {
		wg.Add(1)
		go func(sidecar *KernelSidecar) {
			defer wg.Done()
			sidecar.Stop()
		}(sc)
	}
	wg.Wait()
}
