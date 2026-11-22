//go:build !no_builtin_renderers

package subaggregator

import "sort"

func mihomoRelayProxyName(nodeID string) string {
	return mihomoRelayProxyPrefix + safeProxyNameRegex.ReplaceAllString(nodeID, "_")
}

func singBoxRelayInboundTag(nodeID string) string  { return relayInboundPrefix + nodeID }
func singBoxRelayOutboundTag(nodeID string) string { return relayOutboundPrefix + nodeID }

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
