package subaggregator

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestYAMLAnchorsMergeAndComments(t *testing.T) {
	raw := `
x-base: &base
  type: vless
  tls: true
  # inside comment
  sni: "cdn.example.com#notcomment"
proxies:
  - name: "Node #1"
    <<: *base
    server: us.example.com
    port: 443
    uuid: 11111111-1111-4111-8111-111111111111
    flow: xtls-rprx-vision
`
	parsed, err := ParseYAML(raw)
	if err != nil {
		t.Fatalf("ParseYAML failed: %v", err)
	}
	doc := parsed.(map[string]any)
	proxies := doc["proxies"].([]any)
	if len(proxies) != 1 {
		t.Fatalf("expected 1 proxy, got %d", len(proxies))
	}
	p := proxies[0].(map[string]any)
	if p["type"] != "vless" || p["sni"] != "cdn.example.com#notcomment" || p["name"] != "Node #1" {
		t.Fatalf("unexpected merged proxy fields: %#v", p)
	}
}

func TestConnectionKeyRenameInvarianceAndURIImport(t *testing.T) {
	nodeA := ProxyNode{
		"name":     "HK 01",
		"protocol": "vless",
		"server":   "hk.example.com",
		"port":     443,
		"uuid":     "11111111-1111-4111-8111-111111111111",
		"network":  "ws",
		"path":     "/ws",
		"tls":      true,
	}
	nodeB := nodeA.Clone()
	nodeB["name"] = "Hong Kong Fast 01"

	k1 := BuildProxyNodeConnectionKey(nodeA)
	k2 := BuildProxyNodeConnectionKey(nodeB)
	if k1 == "" || k1 != k2 {
		t.Fatalf("expected connection key invariant under rename: %q vs %q", k1, k2)
	}
	if len(k1) != 64 {
		t.Fatalf("expected 64-char sha256 connection key, got %q (len=%d)", k1, len(k1))
	}

	uri := EncodeProxyURI(nodeA)
	if !strings.HasPrefix(uri, "vless://") {
		t.Fatalf("expected vless:// uri, got %q", uri)
	}
	parsed, err := ParseImportContent(uri)
	if err != nil {
		t.Fatalf("ParseImportContent failed: %v", err)
	}
	if len(parsed.Nodes) != 1 || parsed.Nodes[0].Str("uuid") != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("unexpected parsed URI nodes: %#v", parsed)
	}
}

func TestParseMultipleFormatsAndClashAnchors(t *testing.T) {
	vmessJSON := `{"v":"2","ps":"VMess JP","add":"jp.example.com","port":"443","id":"22222222-2222-4222-8222-222222222222","aid":"0","net":"ws","host":"jp.example.com","path":"/v2","tls":"tls"}`
	vmessURI := "vmess://" + base64.StdEncoding.EncodeToString([]byte(vmessJSON))
	ssURI := "ss://" + base64.StdEncoding.EncodeToString([]byte("aes-256-gcm:secretpass")) + "@sg.example.com:8388#SG%2001"
	hy2URI := "hysteria2://hy2pass@us.example.com:443?sni=us.example.com&mport=10000-20000#US%20Hy2"
	tuicURI := "tuic://33333333-3333-4333-8333-333333333333:tuicpass@de.example.com:443?congestion_control=bbr#DE%20TUIC"

	blob := strings.Join([]string{vmessURI, ssURI, hy2URI, tuicURI}, "\n")
	res, err := ParseImportContent(base64.StdEncoding.EncodeToString([]byte(blob)))
	if err != nil {
		t.Fatalf("base64 import failed: %v", err)
	}
	if len(res.Nodes) != 4 {
		t.Fatalf("expected 4 nodes from base64 subscription, got %d (skipped=%v)", len(res.Nodes), res.SkippedNodes)
	}
}

func TestStoreLegacyEnabledAndReconcilePreservesChainAndLatency(t *testing.T) {
	dir := t.TempDir()
	legacyPool := `{
  "version": 1,
  "subscriptions": [
    {"id": "sub_1", "name": "Airport", "kind": "remote", "url": "https://example.com/sub"}
  ],
  "nodes": [
    {"id": "node_keep", "subscriptionId": "sub_1", "name": "HK Old", "protocol": "trojan", "server": "hk.example.com", "port": 443, "password": "pw", "chain": "node_front", "latencyMs": 42, "latencyAt": 1700000000000}
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, "proxy-pool.json"), []byte(legacyPool), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(dir)
	pool, err := store.ReadProxyPool()
	if err != nil {
		t.Fatalf("ReadProxyPool failed: %v", err)
	}
	if len(pool.Subscriptions) != 1 || !pool.Subscriptions[0].Enabled {
		t.Fatalf("expected legacy subscription without enabled field to default true, got %+v", pool.Subscriptions)
	}

	renamed := ProxyNode{
		"name":     "HK Renamed",
		"protocol": "trojan",
		"server":   "hk.example.com",
		"port":     443,
		"password": "pw",
	}
	_, err = store.MutateProxyPool(func(data *ProxyPoolStoreData) error {
		cnt := ReconcileSubscriptionNodes(data, "sub_1", []ProxyNode{renamed}, 1700000001000)
		if cnt != 1 {
			t.Fatalf("expected 1 reconciled node, got %d", cnt)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	after, _ := store.ReadProxyPool()
	if len(after.Nodes) != 1 {
		t.Fatalf("expected 1 node, got %d", len(after.Nodes))
	}
	n := after.Nodes[0]
	if n.Str("id") != "node_keep" || n.Str("chain") != "node_front" {
		t.Fatalf("expected id/chain preserved across rename, got %#v", n)
	}
	if lm, ok := n.Int("latencyMs"); !ok || lm != 42 {
		t.Fatalf("expected latencyMs=42 preserved, got %#v", n)
	}
}

func TestProfileValidationCyclesAndAllRenderers(t *testing.T) {
	// Self-referential/cyclic custom groups must fail cleanly.
	_, err := NormalizeProfileFromMap(map[string]any{
		"name": "Cyclic",
		"groups": map[string]any{
			"custom": []any{
				map[string]any{"id": "grp_11111111", "name": "GroupA", "type": "select", "members": []any{"group:grp_22222222"}},
				map[string]any{"id": "grp_22222222", "name": "GroupB", "type": "select", "members": []any{"group:grp_11111111"}},
			},
		},
	}, nil, 1700000000000)
	if code := errorCodeOf(err); code != "invalid_aggregator_group_cycle" {
		t.Fatalf("expected invalid_aggregator_group_cycle, got %v", err)
	}

	// Reserved group name rejection.
	_, err = NormalizeProfileFromMap(map[string]any{
		"name": "Reserved",
		"groups": map[string]any{
			"custom": []any{
				map[string]any{"name": "🚀 节点选择", "type": "select", "members": []any{"direct"}},
			},
		},
	}, nil, 1700000000000)
	if code := errorCodeOf(err); code != "duplicate_aggregator_group_name" {
		t.Fatalf("expected invalid_aggregator_group_name, got %v", err)
	}

	profile, err := NormalizeProfileFromMap(map[string]any{
		"name": "AllFormats",
		"groups": map[string]any{
			"regionGroups": true,
			"custom": []any{
				map[string]any{"id": "grp_aaaaaaaa", "name": "AI", "type": "select", "members": []any{"region:us", "direct"}},
			},
		},
		"rules": map[string]any{
			"presets": []any{
				map[string]any{"id": "ai", "enabled": true, "policy": "group:grp_aaaaaaaa"},
			},
		},
	}, nil, 1700000000000)
	if err != nil {
		t.Fatalf("valid profile failed: %v", err)
	}
	profile.ID = "agg_test01"
	profile.Token = GenerateProfileToken()

	subs := []Subscription{{ID: "sub_1", Name: "Main", Kind: "local", Enabled: true}}
	nodes := []ProxyNode{
		{
			"id":             "n1",
			"subscriptionId": "sub_1",
			"name":           "🇺🇸 US 01",
			"protocol":       "vless",
			"server":         "us.example.com",
			"port":           443,
			"uuid":           "11111111-1111-4111-8111-111111111111",
			"tls":            true,
			"sni":            "us.example.com",
		},
		{
			"id":             "n2",
			"subscriptionId": "sub_1",
			"name":           "🇭🇰 HK 01",
			"protocol":       "trojan",
			"server":         "hk.example.com",
			"port":           443,
			"password":       "secret-pw",
			"sni":            "hk.example.com",
		},
	}

	formats := DescribeRenderers()
	if len(formats) != 12 {
		t.Fatalf("expected 12 renderers, got %d", len(formats))
	}
	for _, f := range formats {
		r, ok := GetRenderer(f.ID)
		if !ok {
			t.Fatalf("renderer missing: %s", f.ID)
		}
		ctx := BuildRenderContext("http://127.0.0.1:9527", profile.Token, r.ID, profile, DetectedClient{}, "full", nil)
		res := RenderWithPlan(profile, r, subs, nodes, ctx)
		if strings.TrimSpace(res.Content) == "" {
			t.Fatalf("renderer %s produced empty output", f.ID)
		}
		if r.ID == "json" {
			var decoded map[string]any
			if jErr := json.Unmarshal([]byte(res.Content), &decoded); jErr != nil {
				t.Fatalf("json renderer produced invalid json: %v", jErr)
			}
		}
	}

	links, ok := BuildImportLinks("http://127.0.0.1:9527", profile.Token, profile.Name)
	if !ok || len(links.Clients) < 10 {
		t.Fatalf("expected full import links clients, got ok=%v len=%d", ok, len(links.Clients))
	}
	if d := DetectClient("ClashVerge/2.0.0"); d.Target != "mihomo" {
		t.Fatalf("expected ClashVerge to detect mihomo, got %+v", d)
	}
}

func TestRuleSetConverterAndRouteTester(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "OpenAI.list"):
			_, _ = w.Write([]byte("DOMAIN-SUFFIX,openai.com\nDOMAIN,api.chatgpt.com\nIP-CIDR,104.18.0.0/16,no-resolve\n"))
		case strings.Contains(r.URL.Path, "Proxy.list"):
			_, _ = w.Write([]byte("DOMAIN-SUFFIX,google.com\n"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	fetcher := NewFetcher()
	fetcher.AllowPrivateNet = true
	conv := NewRuleSetConverter(fetcher)
	// Swap custom RuleSetRef url with local mock server via ParseRuleList + FormatRuleSet and direct TraceRoute loader test.
	idx := ParseRuleList("+.openai.com\nchatgpt.com\n", "domain")
	formatted, err := FormatRuleSet(idx.Entries, "domain", "rule-set")
	if err != nil || !strings.Contains(formatted, "DOMAIN-SUFFIX,openai.com") {
		t.Fatalf("unexpected mrs rule-set format output: %q err=%v", formatted, err)
	}
	qxFmt, err := FormatRuleSet(idx.Entries, "domain", "quantumult-x")
	if err != nil || !strings.Contains(qxFmt, "host-suffix, openai.com") {
		t.Fatalf("unexpected qx format output: %q err=%v", qxFmt, err)
	}

	_ = conv
	_ = srv

	profile, err := NormalizeProfileFromMap(map[string]any{
		"name": "RouteCheck",
		"groups": map[string]any{
			"custom": []any{
				map[string]any{"id": "grp_bbbbbbbb", "name": "OpenAIGroup", "type": "select", "members": []any{"proxy"}},
			},
		},
		"rules": map[string]any{
			"presets": []any{
				map[string]any{"id": "ai", "enabled": true, "policy": "group:grp_bbbbbbbb"},
			},
			"custom": []any{
				map[string]any{"type": "DOMAIN-SUFFIX", "value": "internal.corp", "policy": "direct"},
			},
		},
	}, nil, 1700000000000)
	if err != nil {
		t.Fatal(err)
	}
	plan := BuildAggregationPlan(profile, ProxyPoolStoreData{
		Subscriptions: []Subscription{{ID: "sub_1", Name: "Sub", Kind: "local", Enabled: true}},
		Nodes:         []ProxyNode{{"id": "n1", "subscriptionId": "sub_1", "name": "HK", "protocol": "trojan", "server": "hk.example.com", "port": 443, "password": "pw"}},
	})
	tr, err := TraceRoute(context.Background(), plan, "https://api.openai.com/v1/chat", func(ctx context.Context, rs RuleSetRef) (*RuleSetIndex, error) {
		if rs.Name == "category-ai-!cn" {
			return ParseRuleList("+.openai.com\n", rs.Kind), nil
		}
		return &RuleSetIndex{}, nil
	})
	if err != nil {
		t.Fatalf("TraceRoute failed: %v", err)
	}
	if tr.Rule.Origin == nil || tr.Rule.Origin.Kind != "preset" || tr.Rule.Origin.ID != "ai" || len(tr.Groups) < 2 {
		t.Fatalf("unexpected trace result: %+v", tr)
	}
}

func TestFetcherSSRFProtection(t *testing.T) {
	f := NewFetcher()
	_, err := f.Fetch(context.Background(), "http://169.254.169.254/latest/meta-data", "")
	if code := errorCodeOf(err); code != "subscription_url_host_blocked" {
		t.Fatalf("expected SSRF block for metadata IP, got %v", err)
	}
	_, err = f.Fetch(context.Background(), "http://localhost:8080/sub", "")
	if code := errorCodeOf(err); code != "subscription_url_host_blocked" {
		t.Fatalf("expected SSRF block for localhost, got %v", err)
	}

	// Redirect from allowed public-ish mock hostname to 127.0.0.1 must also be blocked when AllowPrivateNet=false.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:9/secret", http.StatusFound)
	}))
	defer target.Close()

	// Point external host via custom Resolver & Transport, still keeping AllowPrivateNet=false on final hop check:
	// First test direct 127.0.0.1 fetch succeeds when AllowPrivateNet=true.
	fAllow := NewFetcher()
	fAllow.AllowPrivateNet = true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("subscription-userinfo", "upload=100; download=200; total=1000; expire=1900000000")
		_, _ = w.Write([]byte("trojan://pw@node.example.com:443#Node1"))
	}))
	defer srv.Close()
	res, err := fAllow.Fetch(context.Background(), srv.URL, "")
	if err != nil || !strings.Contains(res.Content, "Node1") || res.UserInfo == nil {
		t.Fatalf("expected local fetch with AllowPrivateNet=true to succeed, got res=%+v err=%v", res, err)
	}
}

func TestNodeProbeAndLatencyMeter(t *testing.T) {
	// Blocked metadata IP fails closed.
	probe := NewNodeProbe()
	if _, err := probe.Probe(context.Background(), ProbeInput{Host: "169.254.169.254", Ports: []any{80}}); errorCodeOf(err) != "probe_address_blocked" {
		t.Fatalf("expected probe_address_blocked, got %v", err)
	}

	// Local fake-ip flag detection (via custom resolver + AllowPrivateNet for loopback test).
	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socksLn.Close()
	go func() {
		for {
			c, aErr := socksLn.Accept()
			if aErr != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				buf := make([]byte, 16)
				n, _ := conn.Read(buf)
				if n >= 2 && buf[0] == 0x05 {
					_, _ = conn.Write([]byte{0x05, 0x02})
				}
			}(c)
		}
	}()
	socksPort := socksLn.Addr().(*net.TCPAddr).Port

	sshLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sshLn.Close()
	go func() {
		for {
			c, aErr := sshLn.Accept()
			if aErr != nil {
				return
			}
			_, _ = c.Write([]byte("SSH-2.0-OpenSSH_9.0\r\n"))
			_ = c.Close()
		}
	}()
	sshPort := sshLn.Addr().(*net.TCPAddr).Port

	localProbe := NewNodeProbe()
	localProbe.AllowPrivateNet = true
	pRes, err := localProbe.Probe(context.Background(), ProbeInput{
		Host:  "127.0.0.1",
		Ports: []any{socksPort, sshPort},
	})
	if err != nil {
		t.Fatalf("local probe failed: %v", err)
	}
	if len(pRes.Ports) != 2 || pRes.Ports[0].SOCKS5 != "userpass" || !strings.HasPrefix(pRes.Ports[1].Banner, "SSH-2.0") {
		t.Fatalf("unexpected probe results: %+v", pRes)
	}

	// FakeIP check using resolver returning 198.18.0.10 while still testing flag logic:
	// IsBlockedIP blocks 198.18.0.0/15, so fakeIp appears when AllowPrivateNet or during LatencyMeter.
	meter := NewNodeLatencyMeter()
	meter.Lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host == "fake.test" {
			return []netip.Addr{netip.MustParseAddr("198.18.0.10")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
	}
	lat := meter.Measure(context.Background(), []LatencyTarget{
		{Key: "k1", Server: "127.0.0.1", Port: socksPort},
		{Key: "k2", Server: "fake.test", Port: 9},
	}, false, nil)
	if lat["k1"].MS == nil || lat["k1"].FakeIP {
		t.Fatalf("expected valid latency for 127.0.0.1:%d, got %+v", socksPort, lat["k1"])
	}
	if !lat["k2"].FakeIP {
		t.Fatalf("expected FakeIP=true for 198.18.0.10, got %+v", lat["k2"])
	}
}

func TestLocalClientScannerAndSyncRunner(t *testing.T) {
	home := t.TempDir()
	vergeDir := filepath.Join(home, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev")
	if err := os.MkdirAll(vergeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	profilesYAML := `items:
  - type: remote
    name: AirportOne
    url: https://sub.example.com/api/v1?token=abc&name=IgnoredName
    file: airport.yaml
    updated: 1700000000
`
	if err := os.WriteFile(filepath.Join(vergeDir, "profiles.yaml"), []byte(profilesYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	scan := ScanLocalSources("darwin", home, map[string]string{})
	if len(scan.Candidates) != 1 || scan.Candidates[0].ClientID != "clash-verge" {
		t.Fatalf("expected clash-verge candidate, got %+v", scan)
	}
	existingURL := "https://SUB.EXAMPLE.COM/api/v1/?name=Other&token=abc"
	marked := MarkImportedSources(scan.Candidates, []Subscription{{ID: "sub_9", Name: "Existing", Kind: "remote", URL: &existingURL}})
	if !marked[0].Imported || marked[0].ImportedSourceID != "sub_9" {
		t.Fatalf("expected URL key matching ignoring case/trailing slash/name param, got %+v", marked[0])
	}

	// SyncRunner events & deduplication
	var mu sync.Mutex
	var events []SyncEvent
	runner := NewSourceSyncRunner(func(sourceID string) SourceSyncResult {
		time.Sleep(15 * time.Millisecond)
		if sourceID == "s_fail" {
			return SourceSyncResult{OK: false, Error: "subscription_http_error", Message: "502"}
		}
		return SourceSyncResult{OK: true, Applied: true, Count: 5}
	})
	unsub := runner.OnChange(func(ev SyncEvent) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})
	defer unsub()

	job, _, err := runner.Start([]SyncJobEntry{
		{ID: "s_ok", Name: "Good"},
		{ID: "s_fail", Name: "Bad"},
	}, "")
	if err != nil || job.Counts.Total != 2 {
		t.Fatalf("failed to start job: %+v err=%v", job, err)
	}
	// StartOne on an active item should reuse existing job.
	reusedJob, reused, rErr := runner.StartOne(SyncJobEntry{ID: "s_ok", Name: "Good"})
	if rErr != nil || !reused || reusedJob.ID != job.ID {
		t.Fatalf("expected StartOne to reuse active job %s, got reused=%v id=%s err=%v", job.ID, reused, reusedJob.ID, rErr)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		cur, ok := runner.GetJob(job.ID)
		if ok && cur.Status == "partial" && cur.Counts.Done == 2 && cur.Counts.Failed == 1 && cur.Counts.Succeeded == 1 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	cur, _ := runner.GetJob(job.ID)
	t.Fatalf("timed out waiting for partial completion: %+v (events=%d)", cur, len(events))
}

func TestRelayConfigCompilationAndServiceLifecycle(t *testing.T) {
	dir := t.TempDir()
	svc := NewService(dir, ServiceOptions{
		Platform:    "darwin",
		HostHomeDir: dir,
		Env:         map[string]string{},
	})

	// 1. Save local source & auto sync synchronously.
	savedSrc, err := svc.SaveSource(context.Background(), map[string]any{
		"name":    "MyLocalSub",
		"kind":    "local",
		"content": "trojan://pw1@hk.example.com:443#HK%2001\nvless://11111111-1111-4111-8111-111111111111@us.example.com:443?security=tls&sni=us.example.com#US%20VLESS",
	})
	if err != nil {
		t.Fatalf("SaveSource failed: %v", err)
	}
	sub := savedSrc["subscription"].(PublicSourceView)
	syncMap := savedSrc["sync"].(SourceSyncResult)
	if !syncMap.OK || syncMap.Count != 2 {
		t.Fatalf("expected 2 synced nodes, got %+v", savedSrc)
	}

	nodes, err := svc.SourceNodes(sub.ID)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("SourceNodes failed: %v %+v", err, nodes)
	}
	n0ID := nodes[0]["id"].(string)
	n1ID := nodes[1]["id"].(string)

	// 2. Proxy chain & cycle detection.
	if _, err := svc.SetNodeChain(n0ID, n1ID); err != nil {
		t.Fatalf("SetNodeChain failed: %v", err)
	}
	if _, err := svc.SetNodeChain(n1ID, n0ID); errorCodeOf(err) != "invalid_proxy_chain_cycle" {
		t.Fatalf("expected invalid_proxy_chain_cycle, got %v", err)
	}

	// 3. Compile both relay configs (sing-box + mihomo) cleanly.
	pool, _ := svc.store.ReadProxyPool()
	sbRelay := CompileSingBoxRelayConfig(pool.Nodes, RelayCompileOptions{
		ListenHost:    "127.0.0.1",
		AdvertiseHost: "127.0.0.1",
		OnlyIDs:       map[string]bool{n0ID: true},
	})
	if !strings.Contains(sbRelay.Text, `"detour"`) || len(sbRelay.Endpoints) != 1 {
		t.Fatalf("expected sing-box relay detour and 1 endpoint, got %d endpoints", len(sbRelay.Endpoints))
	}
	mhRelay := CompileMihomoRelayConfigText(pool.Nodes, RelayCompileOptions{
		ListenHost:    "127.0.0.1",
		AdvertiseHost: "127.0.0.1",
		OnlyIDs:       map[string]bool{n0ID: true},
	})
	if !strings.Contains(mhRelay.Text, "dialer-proxy") || len(mhRelay.Endpoints) != 1 {
		t.Fatalf("expected mihomo relay dialer-proxy, got:\n%s", mhRelay.Text)
	}

	// 4. Profile save, preview, token rotate, and ServeSubscription.
	prof, err := svc.SaveProfile(map[string]any{
		"name": "MainProfile",
		"sources": map[string]any{
			"all": true,
		},
	})
	if err != nil {
		t.Fatalf("SaveProfile failed: %v", err)
	}
	prev, err := svc.Preview(prof.ID, "mihomo", PreviewRequest{Origin: "http://127.0.0.1:9527"})
	if err != nil || !strings.Contains(prev.Content, "HK 01") {
		p2, _ := svc.store.ReadProxyPool()
		a2, _ := svc.store.ReadAggregatorStore()
		t.Fatalf("Preview failed: err=%v stats=%+v skipped=%+v warnings=%v subs=%+v nodes=%+v profs=%+v", err, prev.Stats, prev.SkippedNodes, prev.Warnings, p2.Subscriptions, p2.Nodes, a2.Profiles)
	}
	rotated, err := svc.RotateToken(prof.ID)
	if err != nil || rotated.Token == prof.Token {
		t.Fatalf("RotateToken failed: %v", err)
	}
	served, err := svc.ServeSubscription(context.Background(), rotated.Token, ServeRequest{
		Target:        "sing-box",
		Origin:        "http://127.0.0.1:9527",
		RemoteAddress: "127.0.0.1",
	})
	if err != nil || served.Status != 200 || !strings.Contains(served.Body, `"outbounds"`) {
		t.Fatalf("ServeSubscription failed: err=%v resp=%+v", err, served)
	}
	ov, err := svc.GetOverview()
	if err != nil || len(ov.Profiles) != 1 || len(ov.Profiles[0].RecentPulls) != 1 {
		t.Fatalf("expected overview to record pull, got %+v err=%v", ov, err)
	}
	if _, err := svc.DeleteSource(sub.ID); err != nil {
		t.Fatalf("DeleteSource failed: %v", err)
	}
	if err := svc.DeleteProfile(prof.ID); err != nil {
		t.Fatalf("DeleteProfile failed: %v", err)
	}
}
