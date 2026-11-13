package subaggregator

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	MaxProbePorts         = 32
	ProbePortConcurrency  = 8
	ProbeConnectTimeout   = 3000 * time.Millisecond
	ProbeBannerWait       = 400 * time.Millisecond
	ProbeHandshakeTimeout = 2000 * time.Millisecond
	LatencyDefaultTimeout = 3000 * time.Millisecond
	LatencyConcurrency    = 64
	LatencyCacheTTL       = 5 * time.Minute
	LatencyMaxTargets     = 4000
	connectProbeTarget    = "www.gstatic.com:443"
)

var (
	CommonProbePorts = []int{443, 8443, 2053, 2083, 2087, 2096, 80, 8080, 8880, 1080, 8388, 22}
	probeHostPattern = regexp.MustCompile(`(?i)^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$`)
	httpStatusRegex  = regexp.MustCompile(`^HTTP/1\.[01] (\d{3})`)
)

// ProbeInput 描述节点探针的输入参数。
type ProbeInput struct {
	Host  string `json:"host"`
	Port  any    `json:"port,omitempty"`
	Ports []any  `json:"ports,omitempty"`
}

// ProbeTLSInfo 记录端口 TLS 握手收集的证书与 CONNECT 信息。
type ProbeTLSInfo struct {
	ALPN        string   `json:"alpn"`
	Names       []string `json:"names"`
	Issuer      string   `json:"issuer"`
	SelfSigned  bool     `json:"selfSigned"`
	ValidTo     string   `json:"validTo"`
	SNIMatch    *bool    `json:"sniMatch"`
	ProxyStatus int      `json:"proxyStatus"`
}

// ProbePortResult 记录单个端口的探测结果与协议推断。
type ProbePortResult struct {
	Port       int           `json:"port"`
	Open       bool          `json:"open"`
	LatencyMs  int64         `json:"latencyMs,omitempty"`
	Error      string        `json:"error,omitempty"`
	Banner     string        `json:"banner,omitempty"`
	TLS        *ProbeTLSInfo `json:"tls,omitempty"`
	SOCKS5     string        `json:"socks5,omitempty"`
	HTTPStatus int           `json:"httpStatus,omitempty"`
	Candidates []string      `json:"candidates"`
	Note       string        `json:"note"`
}

// ProbeResult 描述节点探针的整体返回结果。
type ProbeResult struct {
	OK        bool              `json:"ok"`
	Host      string            `json:"host"`
	Addresses []string          `json:"addresses"`
	DNSError  string            `json:"dnsError,omitempty"`
	FakeIP    bool              `json:"fakeIp"`
	Ports     []ProbePortResult `json:"ports"`
}

// NormalizeProbeInput 校验并规范化探针输入的主机与端口列表。
func NormalizeProbeInput(input ProbeInput) (string, []int, error) {
	host := strings.TrimSpace(input.Host)
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	host = strings.ToLower(host)
	if host == "" || len(host) > 253 {
		return "", nil, errInvalid("invalid_probe_host")
	}
	if _, err := netip.ParseAddr(host); err != nil && !probeHostPattern.MatchString(host) {
		return "", nil, errInvalid("invalid_probe_host")
	}

	var rawPorts []any
	if len(input.Ports) > 0 {
		rawPorts = input.Ports
	} else if input.Port != nil && toString(input.Port) != "" {
		rawPorts = []any{input.Port}
	}

	seen := make(map[int]bool, len(rawPorts))
	ports := make([]int, 0, len(rawPorts))
	for _, raw := range rawPorts {
		p, ok := toInt(raw)
		if !ok || p < 1 || p > 65535 {
			return "", nil, errInvalid("invalid_probe_port")
		}
		if !seen[p] {
			seen[p] = true
			ports = append(ports, p)
		}
	}
	if len(ports) > MaxProbePorts {
		return "", nil, errInvalid("too_many_probe_ports")
	}
	if len(ports) == 0 {
		ports = append([]int(nil), CommonProbePorts...)
	}
	return host, ports, nil
}

// CertificateCovers 判断证书名称列表是否覆盖目标域名（支持单级通配符）。
func CertificateCovers(names []string, servername string) bool {
	target := strings.ToLower(strings.TrimSpace(servername))
	for _, raw := range names {
		pattern := strings.ToLower(strings.TrimSpace(raw))
		if strings.HasPrefix(pattern, "*.") {
			suffix := pattern[1:]
			if strings.HasSuffix(target, suffix) && strings.Count(target, ".") == strings.Count(pattern, ".") {
				return true
			}
			continue
		}
		if pattern == target {
			return true
		}
	}
	return false
}

// ClassifyProbePort 根据端口探测线索推断协议候选与人类可读说明。
func ClassifyProbePort(res ProbePortResult) ([]string, string) {
	if !res.Open {
		return []string{}, ""
	}
	if strings.HasPrefix(res.Banner, "SSH-") {
		return []string{"ssh"}, fmt.Sprintf("SSH 服务（%s）", res.Banner)
	}
	if res.SOCKS5 != "" {
		note := "SOCKS5 代理，拒绝了认证方式"
		if res.SOCKS5 == "userpass" {
			note = "SOCKS5 代理，需要用户名密码"
		} else if res.SOCKS5 == "none" {
			note = "SOCKS5 代理，无需认证"
		}
		return []string{"socks5"}, note
	}
	if res.TLS != nil {
		if res.TLS.ProxyStatus == 407 || res.TLS.ProxyStatus == 200 {
			note := "HTTPS 代理，无需认证"
			if res.TLS.ProxyStatus == 407 {
				note = "HTTPS 代理，需要认证"
			}
			return []string{"https"}, note
		}
		if res.TLS.SNIMatch != nil && !*res.TLS.SNIMatch && len(res.TLS.Names) > 0 {
			return []string{"vless", "trojan", "anytls"}, fmt.Sprintf(
				"证书属于 %s，与地址不符：可能是 REALITY（伪装成该网站，填它作 SNI），也可能是证书配错",
				res.TLS.Names[0],
			)
		}
		alpnPart := ""
		if res.TLS.ALPN != "" {
			alpnPart = fmt.Sprintf("（ALPN %s）", res.TLS.ALPN)
		}
		return []string{"trojan", "vless", "vmess", "anytls", "https"}, fmt.Sprintf(
			"TLS 服务%s：需要凭据的协议识别不出具体是哪种", alpnPart,
		)
	}
	if res.HTTPStatus == 407 || res.HTTPStatus == 200 {
		note := "HTTP 代理，无需认证"
		if res.HTTPStatus == 407 {
			note = "HTTP 代理，需要认证"
		}
		return []string{"http"}, note
	}
	if res.HTTPStatus > 0 {
		return []string{"vmess", "vless"}, fmt.Sprintf("HTTP 服务（状态 %d）：可能是 WebSocket 传输，或者只是网站", res.HTTPStatus)
	}
	if res.Banner != "" {
		return []string{}, fmt.Sprintf("服务端主动发送：%s", res.Banner)
	}
	return []string{"shadowsocks", "vmess", "vless", "trojan"}, "端口开放但不回应：需要凭据的协议（Shadowsocks、无 TLS 的 VMess / VLESS 等）"
}

func printableBanner(raw []byte, limit int) string {
	line := string(raw)
	if idx := strings.IndexByte(line, '\n'); idx >= 0 {
		line = line[:idx]
	}
	line = strings.TrimSuffix(line, "\r")
	if len(line) > limit {
		line = line[:limit]
	}
	var out strings.Builder
	for i := 0; i < len(line); i++ {
		b := line[i]
		if b >= 0x20 && b <= 0x7e {
			out.WriteByte(b)
		} else {
			out.WriteByte('.')
		}
	}
	return strings.TrimSpace(out.String())
}

func mapProbeDialErr(err error) string {
	if err == nil {
		return ""
	}
	var netErr net.Error
	if opErr, ok := err.(*net.OpError); ok && opErr.Timeout() {
		return "ETIMEDOUT"
	}
	if errorsIsTimeout(err) || (err != nil && (err == context.DeadlineExceeded || (errorsAsNetError(err, &netErr) && netErr.Timeout()))) {
		return "ETIMEDOUT"
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "refused"):
		return "ECONNREFUSED"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "timed out"):
		return "ETIMEDOUT"
	case strings.Contains(msg, "unreachable"):
		return "EHOSTUNREACH"
	case strings.Contains(msg, "reset"):
		return "ECONNRESET"
	default:
		return "ECONNREFUSED"
	}
}

func errorsAsNetError(err error, target *net.Error) bool {
	if ne, ok := err.(net.Error); ok {
		*target = ne
		return true
	}
	return false
}

func errorsIsTimeout(err error) bool {
	if ne, ok := err.(interface{ Timeout() bool }); ok {
		return ne.Timeout()
	}
	return false
}

// NodeProbe 对节点主机与端口做只读协议嗅探（含 SSRF 保护与 Fake-IP 识别）。
type NodeProbe struct {
	Lookup           func(context.Context, string) ([]netip.Addr, error)
	DialTimeout      time.Duration
	BannerWait       time.Duration
	HandshakeTimeout time.Duration
	AllowPrivateNet  bool
}

// NewNodeProbe 构造默认参数的服务端探针。
func NewNodeProbe() *NodeProbe {
	return &NodeProbe{
		DialTimeout:      ProbeConnectTimeout,
		BannerWait:       ProbeBannerWait,
		HandshakeTimeout: ProbeHandshakeTimeout,
	}
}

func (p *NodeProbe) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip.Unmap()}, nil
	}
	var addrs []netip.Addr
	var err error
	if p.Lookup != nil {
		addrs, err = p.Lookup(ctx, host)
	} else {
		addrs, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}
	if err != nil || len(addrs) == 0 {
		return nil, fmt.Errorf("ENOTFOUND")
	}
	v4 := make([]netip.Addr, 0, len(addrs))
	v6 := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		a = a.Unmap()
		if a.Is4() {
			v4 = append(v4, a)
		} else {
			v6 = append(v6, a)
		}
	}
	return append(v4, v6...), nil
}

func (p *NodeProbe) connectTimeout() time.Duration {
	if p.DialTimeout > 0 {
		return p.DialTimeout
	}
	return ProbeConnectTimeout
}

func (p *NodeProbe) bannerWait() time.Duration {
	if p.BannerWait > 0 {
		return p.BannerWait
	}
	return ProbeBannerWait
}

func (p *NodeProbe) handshakeTimeout() time.Duration {
	if p.HandshakeTimeout > 0 {
		return p.HandshakeTimeout
	}
	return ProbeHandshakeTimeout
}

func (p *NodeProbe) openSocket(ctx context.Context, addr netip.Addr, port int, timeout time.Duration) (net.Conn, int64, error) {
	target := net.JoinHostPort(addr.String(), strconv.Itoa(port))
	started := time.Now()
	d := &net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", target)
	if err != nil {
		return nil, 0, err
	}
	return conn, time.Since(started).Milliseconds(), nil
}

func readFirstChunk(conn net.Conn, wait time.Duration) []byte {
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if n > 0 {
		return buf[:n]
	}
	if err != nil && err != io.EOF {
		return nil
	}
	return nil
}

func (p *NodeProbe) exchange(ctx context.Context, addr netip.Addr, port int, payload []byte) []byte {
	timeout := p.handshakeTimeout()
	conn, _, err := p.openSocket(ctx, addr, port, timeout)
	if err != nil {
		return nil
	}
	defer conn.Close()
	_ = conn.SetWriteDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(payload); err != nil {
		return nil
	}
	return readFirstChunk(conn, timeout)
}

func (p *NodeProbe) probeSOCKS5(ctx context.Context, addr netip.Addr, port int) string {
	reply := p.exchange(ctx, addr, port, []byte{0x05, 0x02, 0x00, 0x02})
	if len(reply) < 2 || reply[0] != 0x05 {
		return ""
	}
	switch reply[1] {
	case 0x00:
		return "none"
	case 0x02:
		return "userpass"
	default:
		return "rejected"
	}
}

func (p *NodeProbe) probeHTTPConnect(ctx context.Context, addr netip.Addr, port int) int {
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", connectProbeTarget, connectProbeTarget)
	reply := p.exchange(ctx, addr, port, []byte(req))
	if len(reply) == 0 {
		return 0
	}
	m := httpStatusRegex.FindSubmatch(reply)
	if len(m) < 2 {
		return 0
	}
	code, _ := strconv.Atoi(string(m[1]))
	return code
}

func (p *NodeProbe) probeTLS(ctx context.Context, addr netip.Addr, port int, servername string) *ProbeTLSInfo {
	timeout := p.handshakeTimeout()
	target := net.JoinHostPort(addr.String(), strconv.Itoa(port))
	dialer := &net.Dialer{Timeout: timeout}
	cfg := &tls.Config{
		ServerName:         servername,
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true,
	}
	conn, err := tls.DialWithDialer(dialer, "tcp", target, cfg)
	if err != nil {
		return nil
	}
	defer conn.Close()
	state := conn.ConnectionState()
	var names []string
	var issuer, validTo string
	var selfSigned bool
	if len(state.PeerCertificates) > 0 {
		cert := state.PeerCertificates[0]
		if len(cert.DNSNames) > 0 {
			names = append(names, cert.DNSNames...)
		} else if cert.Subject.CommonName != "" {
			names = append(names, cert.Subject.CommonName)
		}
		if len(names) > 10 {
			names = names[:10]
		}
		if len(cert.Issuer.Organization) > 0 {
			issuer = cert.Issuer.Organization[0]
		} else {
			issuer = cert.Issuer.CommonName
		}
		selfSigned = bytes.Equal(cert.RawIssuer, cert.RawSubject)
		validTo = cert.NotAfter.UTC().Format(time.RFC1123)
	}
	var sniMatch *bool
	if servername != "" {
		matched := CertificateCovers(names, servername)
		sniMatch = &matched
	}
	info := &ProbeTLSInfo{
		ALPN:       state.NegotiatedProtocol,
		Names:      names,
		Issuer:     issuer,
		SelfSigned: selfSigned,
		ValidTo:    validTo,
		SNIMatch:   sniMatch,
	}
	if info.Names == nil {
		info.Names = []string{}
	}
	// 同连接尝试 HTTP CONNECT 识别 HTTPS 代理（含 NaiveProxy）。
	_ = conn.SetWriteDeadline(time.Now().Add(timeout))
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", connectProbeTarget, connectProbeTarget)
	if _, err := conn.Write([]byte(req)); err == nil {
		if reply := readFirstChunk(conn, timeout); len(reply) > 0 {
			if m := httpStatusRegex.FindSubmatch(reply); len(m) >= 2 {
				info.ProxyStatus, _ = strconv.Atoi(string(m[1]))
			}
		}
	}
	return info
}

func (p *NodeProbe) probePort(ctx context.Context, addr netip.Addr, port int, servername string) ProbePortResult {
	conn, latencyMs, err := p.openSocket(ctx, addr, port, p.connectTimeout())
	if err != nil {
		return ProbePortResult{
			Port:       port,
			Open:       false,
			Error:      mapProbeDialErr(err),
			Candidates: []string{},
			Note:       "",
		}
	}
	res := ProbePortResult{
		Port:      port,
		Open:      true,
		LatencyMs: latencyMs,
	}
	banner := readFirstChunk(conn, p.bannerWait())
	_ = conn.Close()
	if len(banner) > 0 {
		res.Banner = printableBanner(banner, 80)
	} else {
		if tlsInfo := p.probeTLS(ctx, addr, port, servername); tlsInfo != nil {
			res.TLS = tlsInfo
		} else if socks5 := p.probeSOCKS5(ctx, addr, port); socks5 != "" {
			res.SOCKS5 = socks5
		} else if httpStatus := p.probeHTTPConnect(ctx, addr, port); httpStatus > 0 {
			res.HTTPStatus = httpStatus
		}
	}
	res.Candidates, res.Note = ClassifyProbePort(res)
	if res.Candidates == nil {
		res.Candidates = []string{}
	}
	return res
}

// Probe 执行完整主机 DNS 解析（Fail-Closed SSRF 检查）与多端口并发探测。
func (p *NodeProbe) Probe(ctx context.Context, input ProbeInput) (ProbeResult, error) {
	host, ports, err := NormalizeProbeInput(input)
	if err != nil {
		return ProbeResult{}, err
	}
	addrs, err := p.resolve(ctx, host)
	if err != nil || len(addrs) == 0 {
		return ProbeResult{
			OK:        true,
			Host:      host,
			Addresses: []string{},
			DNSError:  "ENOTFOUND",
			FakeIP:    false,
			Ports:     []ProbePortResult{},
		}, nil
	}
	if !p.AllowPrivateNet {
		for _, a := range addrs {
			if IsBlockedIP(a) {
				return ProbeResult{}, errInvalid("probe_address_blocked")
			}
		}
	}
	addr := addrs[0]
	servername := ""
	if _, parseErr := netip.ParseAddr(host); parseErr != nil {
		servername = host
	}

	results := make([]ProbePortResult, len(ports))
	sem := make(chan struct{}, ProbePortConcurrency)
	var wg sync.WaitGroup
	for i, port := range ports {
		wg.Add(1)
		go func(idx, targetPort int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[idx] = p.probePort(ctx, addr, targetPort, servername)
		}(i, port)
	}
	wg.Wait()

	addrStrs := make([]string, 0, minInt(8, len(addrs)))
	hasV4 := false
	allV4Fake := true
	for i, a := range addrs {
		if i < 8 {
			addrStrs = append(addrStrs, a.String())
		}
		if a.Is4() {
			hasV4 = true
			if !IsFakeIPAddr(a) {
				allV4Fake = false
			}
		}
	}
	return ProbeResult{
		OK:        true,
		Host:      host,
		Addresses: addrStrs,
		FakeIP:    hasV4 && allV4Fake,
		Ports:     results,
	}, nil
}

// LatencyTarget 描述待测 TCP 建连延迟的目标。
type LatencyTarget struct {
	Key    string
	Server string
	Port   int
}

// LatencyResult 记录单个节点的 TCP 建连测速结果。
type LatencyResult struct {
	MS         *int64 `json:"ms"`
	Error      string `json:"error,omitempty"`
	FakeIP     bool   `json:"fakeIp"`
	MeasuredAt int64  `json:"measuredAt"`
}

type latencyCacheEntry struct {
	key string
	val LatencyResult
}

// NodeLatencyMeter 并发测量 TCP 建连耗时（带 5 分钟缓存与 Fake-IP 检测）。
type NodeLatencyMeter struct {
	Timeout     time.Duration
	Concurrency int
	CacheTTL    time.Duration
	MaxTargets  int
	Now         func() time.Time
	Lookup      func(context.Context, string) ([]netip.Addr, error)

	mu    sync.Mutex
	cache map[string]LatencyResult
	order []string
}

// NewNodeLatencyMeter 构造节点延迟测量器。
func NewNodeLatencyMeter() *NodeLatencyMeter {
	return &NodeLatencyMeter{
		Timeout:     LatencyDefaultTimeout,
		Concurrency: LatencyConcurrency,
		CacheTTL:    LatencyCacheTTL,
		MaxTargets:  LatencyMaxTargets,
		Now:         time.Now,
		cache:       make(map[string]LatencyResult),
	}
}

func (m *NodeLatencyMeter) clock() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (m *NodeLatencyMeter) timeout() time.Duration {
	if m.Timeout > 0 {
		return m.Timeout
	}
	return LatencyDefaultTimeout
}

func (m *NodeLatencyMeter) measureOne(ctx context.Context, server string, port int) LatencyResult {
	nowMs := m.clock().UnixMilli()
	host := strings.TrimSpace(server)
	if host == "" || !isValidPort(port) {
		return LatencyResult{MS: nil, Error: "ECONNREFUSED", FakeIP: false, MeasuredAt: nowMs}
	}
	timeout := m.timeout()
	started := time.Now()
	fakeIP := false
	var targetHost string
	if ip, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		ip = ip.Unmap()
		fakeIP = IsFakeIPAddr(ip)
		targetHost = ip.String()
	} else {
		var addrs []netip.Addr
		var rErr error
		if m.Lookup != nil {
			addrs, rErr = m.Lookup(ctx, host)
		} else {
			lCtx, cancel := context.WithTimeout(ctx, timeout)
			addrs, rErr = net.DefaultResolver.LookupNetIP(lCtx, "ip", host)
			cancel()
		}
		if rErr != nil || len(addrs) == 0 {
			code := "ENOTFOUND"
			if ctxErr := ctx.Err(); ctxErr != nil {
				code = "ETIMEDOUT"
			} else if rErr != nil && errorsIsTimeout(rErr) {
				code = "ETIMEDOUT"
			}
			return LatencyResult{MS: nil, Error: code, FakeIP: false, MeasuredAt: m.clock().UnixMilli()}
		}
		picked := addrs[0].Unmap()
		for _, a := range addrs {
			a = a.Unmap()
			if a.Is4() {
				picked = a
				break
			}
		}
		fakeIP = IsFakeIPAddr(picked)
		targetHost = picked.String()
	}

	dialer := &net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(targetHost, strconv.Itoa(port)))
	measuredAt := m.clock().UnixMilli()
	if err != nil {
		return LatencyResult{MS: nil, Error: mapProbeDialErr(err), FakeIP: fakeIP, MeasuredAt: measuredAt}
	}
	_ = conn.Close()
	ms := time.Since(started).Milliseconds()
	return LatencyResult{MS: &ms, FakeIP: fakeIP, MeasuredAt: measuredAt}
}

// Measure 并发测量一批目标的 TCP 建连耗时。
func (m *NodeLatencyMeter) Measure(ctx context.Context, targets []LatencyTarget, fresh bool, onResult func(string, LatencyResult)) map[string]LatencyResult {
	limit := m.MaxTargets
	if limit <= 0 {
		limit = LatencyMaxTargets
	}
	if len(targets) > limit {
		targets = targets[:limit]
	}
	results := make(map[string]LatencyResult, len(targets))
	type pendingTarget struct {
		target   LatencyTarget
		cacheKey string
	}
	var pending []pendingTarget
	nowMs := m.clock().UnixMilli()
	ttlMs := m.CacheTTL.Milliseconds()

	m.mu.Lock()
	for _, t := range targets {
		ck := fmt.Sprintf("%s:%d", strings.ToLower(t.Server), t.Port)
		if !fresh {
			if cached, ok := m.cache[ck]; ok && (ttlMs <= 0 || nowMs-cached.MeasuredAt < ttlMs) {
				results[t.Key] = cached
				if onResult != nil {
					onResult(t.Key, cached)
				}
				continue
			}
		}
		pending = append(pending, pendingTarget{target: t, cacheKey: ck})
	}
	m.mu.Unlock()

	if len(pending) > 0 {
		workers := m.Concurrency
		if workers <= 0 {
			workers = LatencyConcurrency
		}
		if workers > len(pending) {
			workers = len(pending)
		}
		ch := make(chan pendingTarget, len(pending))
		for _, p := range pending {
			ch <- p
		}
		close(ch)

		var outMu sync.Mutex
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for p := range ch {
					res := m.measureOne(ctx, p.target.Server, p.target.Port)
					m.mu.Lock()
					if m.cache == nil {
						m.cache = make(map[string]LatencyResult)
					}
					if _, exists := m.cache[p.cacheKey]; !exists {
						m.order = append(m.order, p.cacheKey)
					}
					m.cache[p.cacheKey] = res
					maxCache := limit * 2
					for len(m.order) > maxCache {
						evict := m.order[0]
						m.order = m.order[1:]
						delete(m.cache, evict)
					}
					m.mu.Unlock()

					outMu.Lock()
					results[p.target.Key] = res
					if onResult != nil {
						onResult(p.target.Key, res)
					}
					outMu.Unlock()
				}
			}()
		}
		wg.Wait()
	}
	return results
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
