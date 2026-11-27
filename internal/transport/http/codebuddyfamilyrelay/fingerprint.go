package codebuddyfamilyrelay

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/proxy"

	"github.com/madou1217/ai_home/core/providers"
)

// clientHelloHex 是官方 CodeBuddy CLI 2.187.0 在 2026-11-27 对
// copilot.tencent.com:443 发出的完整 ClientHello（TLS record）。
//
// 它只作为 uTLS 的结构模板：random、session id、key share 每次连接都会重新生成。
// 官方升级 TLS 栈后应重新抓包并更新本常量；结构不兼容时退回原 transport。
const clientHelloHex = `
16030105c7010005c3030311f356bf6277253a99a578dbd2826ad97d181e2bee0f32170452e1e7a079a14520cfaa3076cd6025dfb0834d6d3db3f48f
570afbea9bbf7b58bd1c56f84df89b7e0024130113021303c02fc02bc030c02cc027cca9cca8c009c013c00ac014009c009d002f0035010005560000
00180016000013636f70696c6f742e74656e63656e742e636f6d00170000ff01000100000a000a000811ec001d00170018000b000201000023000000
0d0018001604030804040105030805050108060601080706030201003304ea04e811ec04c07b8ab672797a51922a775a916227819afb6c941a08a940
0dcd23945ae1ceb72c89d9957f6d5762803753f12a5e64380e289259572784ad01b0de669b5ea1a7e526cfcafcc8b8713425b95f6fb4c1ec09b32848
b9c64577d07b0e48e9302a16ce484664d8a25c8d93514f7278962351a0c7a0920326234aaa2b009b9b1cb514f69eda97bfbbb13ca8d3b9cc42135223
6d5150274fdac618568f11a45d08408607aaadeafbb8494caa92eabafdf4196a2157ab33921a172099a0b75a88735b710372d2a276d1b545554a51c1
66ecca88940604492c71ffe05c26dbccd53c2b3430b8d7a23663a04b43f2c65c95548e210cba216db6941a30a058b3962f76244331584352617ce195
414437244a22c0dae170a7a6c441f572c78b0abed57de59724843345b883a4075bc8f3d0c387d251e808bda0672e121a43bf23636b102c4d7ab21929
65f1276ee2bc35f40b3324e725c92a717474bef6a424f5c67456593399abbcbefa3dd0b20349e0769c109d9f981de45cced3679a9fc4a15b8aa5c3b4
c44071279cfac69c567e761c71adb5bbda6cc6094baf1b54a48ea53778d7b8e7328d5400acd38a3111f7009bb5a18b500a91038411d044a299066341
c0b848970433927e8b12f546a732bac93200aa6105732e23cc85243d0ee880ab122f6233308fdc431d4072f7d445eaa9597585bfea2a781c800ef012
722f34a090965bc9204d8e08cb7aac83d41b74d602bbc5164d020c867e860b8d537fcd1a84365c662656a9e431893973cd91b48683e8c7aa755c5182
a65e828afb065504ac7f19802c667c71b4d636db938cd2f612ee739388c73294852ddbc7329b6445e4432f511955c4480bb923c9cf27424a1620b529
385b834b8b371f8b59cde5f5ba2f159f87ea39fda2a4cf919bf21b932643a80f5346a85813ff1a4172748b3406786ad3318851bc18f0538995adee82
9c9f15bccb7942847a9300c413b2d71f84f21f007479a1d1c62c0a5eb6229f4684545e658937c68e95272ecf69223a150912ca286bf16e31d4b1a9a5
ba30ac1301a93f78e289440318df402ea6e5b7417a214da1b8f3548fe44a9f5e089dc050cec37417664496471b21b578b860816329c2b5c55c909248
c8340b5a9ef332b014b0d100571e01cc800351ad904f91c9b649292d7360b87664a563f49f9a545cf5f36b9954613a1c41890a8b75a2bd290697e30b
567159a737c713c6b1519dec0cdd58a50caac52db5cdfa69545f2c974f371165226f3002ba19c68c983b6c642c1988c54385950fa13876248c2a6374
19fdda061a5253c4f56973c352c614a12f2629af0a353110215645a1cc237776311f8011155d780079f776aff5cb4771297fd0bab216c4130c032a63
9170ba8c07c9abb178a341a593fc058de4d30e47f090ea7b00af92c8912cadff234ce4a6aa8b103d10b7bfad207d09027a8fcc2f5912a18c2915949b
2305f785fb75441a0569b1d23b3010904b343d7b66aef75111181a527906255ef1831c32a244e3a28c6b3cfe466072b191d5d13e43bb8953477ce476
69724246ab2588f0c85e6e122e3387277f1b75c3c97f0f2c03731271bee53e3992773a9c279ae49fb0c293b255ba67340cff7a5fcacac86e3eb57d65
3b26b8af65dddf45430355b20a96d23d090f63d8b3185a01c83863a2c56ee83ddaee678da0329bf9de439202148d41ede9a3748425001d00204228fc
021c41d7fff1cc9a427d41e959fe9b3998a1daec6a368750dbcc1a5511002d00020101002b00050403040303`

// officialClientHelloSpec 每次都从原始 ClientHello 重新解析。
//
// 不能缓存 ClientHelloSpec：utls.ApplyPreset 会原地写入随机、GREASE 与
// key_share 私钥对应的公钥；同一份 spec 被下一次连接复用时，key_share
// Data 已非空，ApplyPreset 会跳过重新生成，导致新连接拿不到对应私钥，
// 握手以 tls: internal error 失败（并发请求还会互相踩踏）。
func officialClientHelloSpec() (*utls.ClientHelloSpec, error) {
	raw, err := hex.DecodeString(strings.NewReplacer("\n", "", "\r", "", " ", "", "\t", "").Replace(clientHelloHex))
	if err != nil {
		return nil, fmt.Errorf("decode codebuddy clienthello: %w", err)
	}
	var fingerprinter utls.Fingerprinter
	return fingerprinter.FingerprintClientHello(raw)
}

// NewHostRoutingRoundTripper 只对家族推理 host 使用官方 ClientHello 与官方
// HTTP/1.1 头部顺序；其它 host 原样交给 base。结构不兼容时整体退回 base。
func NewHostRoutingRoundTripper(base *http.Transport) http.RoundTripper {
	if base == nil {
		return http.DefaultTransport
	}
	if _, err := officialClientHelloSpec(); err != nil {
		return base
	}
	return &hostRoutingRoundTripper{
		family: &fingerprintRoundTripper{base: base},
		other:  base,
	}
}

type hostRoutingRoundTripper struct {
	family http.RoundTripper
	other  http.RoundTripper
}

func (roundTripper *hostRoutingRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if request != nil && request.URL != nil && isFamilyInferenceHost(request.URL.Hostname()) {
		return roundTripper.family.RoundTrip(request)
	}
	return roundTripper.other.RoundTrip(request)
}

// fingerprintRoundTripper 自己写 HTTP/1.1 请求：Go 的 http.Transport 会按
// 字母序重排并规范化头部大小写，与官方 CLI 的请求画像不同。
type fingerprintRoundTripper struct {
	base *http.Transport
}

func (roundTripper *fingerprintRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil || request.URL == nil {
		return nil, fmt.Errorf("invalid upstream request")
	}
	spec, err := officialClientHelloSpec()
	if err != nil {
		return nil, err
	}
	proxyURL, err := resolveProxy(roundTripper.base, request)
	if err != nil {
		return nil, err
	}
	address := request.URL.Host
	if request.URL.Port() == "" {
		port := "443"
		if strings.EqualFold(request.URL.Scheme, "http") {
			port = "80"
		}
		address = net.JoinHostPort(request.URL.Hostname(), port)
	}
	conn, err := dialOfficialTLS(request.Context(), "tcp", address, proxyURL, roundTripper.base, spec)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*http.Response, error) {
		_ = conn.Close()
		return nil, err
	}
	headerTimeout := 60 * time.Second
	if roundTripper.base != nil && roundTripper.base.ResponseHeaderTimeout > 0 {
		headerTimeout = roundTripper.base.ResponseHeaderTimeout
	}
	_ = conn.SetDeadline(time.Now().Add(headerTimeout))
	if err := writeOfficialRequest(conn, request); err != nil {
		return fail(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), request)
	if err != nil {
		return fail(err)
	}
	_ = conn.SetDeadline(time.Time{})
	response.Body = &connectionClosingBody{ReadCloser: response.Body, conn: conn}
	return response, nil
}

type connectionClosingBody struct {
	io.ReadCloser
	conn net.Conn
	done bool
}

func (body *connectionClosingBody) Read(buffer []byte) (int, error) {
	n, err := body.ReadCloser.Read(buffer)
	if err == io.EOF {
		body.closeConn()
	}
	return n, err
}

func (body *connectionClosingBody) Close() error {
	err := body.ReadCloser.Close()
	body.closeConn()
	return err
}

func (body *connectionClosingBody) closeConn() {
	if body.done {
		return
	}
	body.done = true
	_ = body.conn.Close()
}

// officialHeaderOrder 是 2026-11-27 抓官方 CodeBuddy CLI 2.187.0 原生请求
// 得到的完整头部顺序与大小写。未知头按字母序追加，不能丢。
var officialHeaderOrder = []string{
	"Accept",
	"Content-Type",
	"x-requested-with",
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-retry-count",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"X-Conversation-ID",
	"X-IDE-Type",
	"X-IDE-Name",
	"X-IDE-Version",
	"X-Agent-Intent",
	"X-Agent-Runtime",
	"X-Private-Data",
	"x-codebuddy-request",
	"X-Request-ID",
	"X-Conversation-Message-ID",
	"X-Conversation-Request-ID",
	"X-Root-Request-ID",
	"X-Agent-Type",
	"X-Agent-Core",
	"X-Feature-Module",
	"baggage",
	"X-Agent-Purpose",
	"traceparent",
	"b3",
	"X-B3-TraceId",
	"X-B3-ParentSpanId",
	"X-B3-SpanId",
	"X-B3-Sampled",
	"X-Trace-ID",
	"X-Product",
	"User-Agent",
	"Authorization",
	"X-User-Id",
	"X-Domain",
}

func writeOfficialRequest(writer io.Writer, request *http.Request) error {
	path := request.URL.RequestURI()
	if path == "" {
		path = "/"
	}
	if _, err := fmt.Fprintf(writer, "%s %s HTTP/1.1\r\n", request.Method, path); err != nil {
		return err
	}
	written := make(map[string]bool, len(officialHeaderOrder))
	for _, name := range officialHeaderOrder {
		value := request.Header.Get(name)
		if strings.TrimSpace(value) == "" {
			continue
		}
		if strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("invalid %s header", name)
		}
		if _, err := fmt.Fprintf(writer, "%s: %s\r\n", name, value); err != nil {
			return err
		}
		written[strings.ToLower(name)] = true
	}
	extra := make([]string, 0)
	for name := range request.Header {
		if written[strings.ToLower(name)] {
			continue
		}
		switch strings.ToLower(name) {
		case "host", "content-length", "connection", "transfer-encoding":
			continue
		}
		extra = append(extra, name)
	}
	sort.Strings(extra)
	for _, name := range extra {
		for _, value := range request.Header.Values(name) {
			if strings.ContainsAny(value, "\r\n") {
				return fmt.Errorf("invalid %s header", name)
			}
			if _, err := fmt.Fprintf(writer, "%s: %s\r\n", name, value); err != nil {
				return err
			}
		}
	}
	if request.ContentLength >= 0 {
		if _, err := fmt.Fprintf(writer, "Content-Length: %d\r\n", request.ContentLength); err != nil {
			return err
		}
	}
	host := request.Host
	if host == "" && request.URL != nil {
		host = request.URL.Host
	}
	if host != "" {
		if _, err := fmt.Fprintf(writer, "Host: %s\r\n", host); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(writer, "Connection: keep-alive\r\n\r\n"); err != nil {
		return err
	}
	if request.Body == nil {
		return nil
	}
	if _, err := io.Copy(writer, request.Body); err != nil {
		return err
	}
	return request.Body.Close()
}

func resolveProxy(base *http.Transport, request *http.Request) (*url.URL, error) {
	if base == nil || base.Proxy == nil {
		return nil, nil
	}
	return base.Proxy(request)
}

func dialOfficialTLS(ctx context.Context, network, addr string, proxyURL *url.URL, base *http.Transport, spec *utls.ClientHelloSpec) (net.Conn, error) {
	raw, err := dialUpstream(ctx, network, addr, proxyURL, base)
	if err != nil {
		return nil, err
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	config := &utls.Config{ServerName: host, MinVersion: utls.VersionTLS12}
	if base != nil && base.TLSClientConfig != nil {
		config.RootCAs = base.TLSClientConfig.RootCAs
		config.InsecureSkipVerify = base.TLSClientConfig.InsecureSkipVerify
	}
	conn := utls.UClient(raw, config, utls.HelloCustom)
	if err := conn.ApplyPreset(spec); err != nil {
		_ = raw.Close()
		return nil, err
	}
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}

func dialUpstream(ctx context.Context, network, addr string, proxyURL *url.URL, base *http.Transport) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	if proxyURL == nil {
		if base != nil && base.DialContext != nil {
			return base.DialContext(ctx, network, addr)
		}
		return dialer.DialContext(ctx, network, addr)
	}
	switch strings.ToLower(proxyURL.Scheme) {
	case "http", "https":
		return dialHTTPProxy(ctx, network, addr, proxyURL, dialer)
	case "socks5", "socks5h":
		return dialSOCKS5Proxy(ctx, network, addr, proxyURL, dialer)
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", proxyURL.Scheme)
	}
}

func dialHTTPProxy(ctx context.Context, network, addr string, proxyURL *url.URL, dialer *net.Dialer) (net.Conn, error) {
	proxyAddr := proxyURL.Host
	if proxyURL.Port() == "" {
		port := "80"
		if strings.EqualFold(proxyURL.Scheme, "https") {
			port = "443"
		}
		proxyAddr = net.JoinHostPort(proxyURL.Hostname(), port)
	}
	conn, err := dialer.DialContext(ctx, network, proxyAddr)
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(proxyURL.Scheme, "https") {
		tlsConn := tls.Client(conn, &tls.Config{ServerName: proxyURL.Hostname(), MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return nil, err
		}
		conn = tlsConn
	}
	request := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: addr},
		Host:   addr,
		Header: make(http.Header),
	}
	if proxyURL.User != nil {
		password, _ := proxyURL.User.Password()
		token := base64.StdEncoding.EncodeToString([]byte(proxyURL.User.Username() + ":" + password))
		request.Header.Set("Proxy-Authorization", "Basic "+token)
	}
	if err := request.Write(conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("proxy CONNECT %s: %s", addr, response.Status)
	}
	return conn, nil
}

func dialSOCKS5Proxy(ctx context.Context, network, addr string, proxyURL *url.URL, dialer *net.Dialer) (net.Conn, error) {
	auth := proxy.Auth{}
	if proxyURL.User != nil {
		auth.User = proxyURL.User.Username()
		auth.Password, _ = proxyURL.User.Password()
	}
	proxyAddr := proxyURL.Host
	if proxyURL.Port() == "" {
		proxyAddr = net.JoinHostPort(proxyURL.Hostname(), "1080")
	}
	socksDialer, err := proxy.SOCKS5("tcp", proxyAddr, &auth, dialer)
	if err != nil {
		return nil, err
	}
	if contextDialer, ok := socksDialer.(proxy.ContextDialer); ok {
		return contextDialer.DialContext(ctx, network, addr)
	}
	return socksDialer.Dial(network, addr)
}

func isFamilyInferenceHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	for _, baseURL := range inferenceBaseURLs {
		if host == providers.ReadUpstreamHost(baseURL) {
			return true
		}
	}
	return false
}
