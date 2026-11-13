package edgeproxy

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	// DefaultAIHPort 是未指定端口时默认使用的 AIH 本机监听端口。
	DefaultAIHPort = 9527
	// DefaultTLSTerminatorPort 是 nginx split 模式下本地终结 TLS 的回环端口。
	DefaultTLSTerminatorPort = 8443

	frpMarkerPrefix = "# aih-managed:"
	nginxMarker     = "# managed by aih (edge-proxy)"
	nginxSiteMarker = "# managed by aih (edge-proxy) - site"
)

var (
	edgeKinds  = []string{"frp", "nginx", "caddy"}
	nginxModes = []string{"split", "passthrough", "http-only"}

	reProxiesHeader = regexp.MustCompile(`^\s*\[\[proxies\]\]\s*$`)
	reFrpMarker     = regexp.MustCompile(`^\s*#\s*aih-managed:`)
	reAnySection    = regexp.MustCompile(`^\s*\[`)
	reKeyVal        = regexp.MustCompile(`^\s*([A-Za-z0-9_.]+)\s*=\s*(.+?)\s*$`)
	reConfPath      = regexp.MustCompile(`--conf-path=([^\s]+)`)
	reNginxVersion  = regexp.MustCompile(`nginx/([0-9.]+)`)
	reSafeDomain    = regexp.MustCompile(`[^A-Za-z0-9.-]`)
	reHTTPBlock     = regexp.MustCompile(`^\s*http\s*\{`)
	reMultiBlank    = regexp.MustCompile(`\n{3,}`)
)

var (
	frpConfigCandidates = []string{
		"/opt/homebrew/etc/frp/frpc.toml",
		"/usr/local/etc/frp/frpc.toml",
		"/etc/frp/frpc.toml",
		"/etc/frp/frpc.ini",
	}
	frpBinCandidates = []string{
		"/opt/homebrew/bin/frpc",
		"/usr/local/bin/frpc",
		"/usr/bin/frpc",
	}
	nginxBinCandidates = []string{
		"/opt/homebrew/bin/nginx",
		"/usr/local/bin/nginx",
		"/usr/sbin/nginx",
		"/usr/bin/nginx",
	}
	nginxDirCandidates = []string{
		"/opt/homebrew/etc/nginx",
		"/usr/local/etc/nginx",
		"/etc/nginx",
	}
	caddyBinCandidates = []string{
		"/opt/homebrew/bin/caddy",
		"/usr/local/bin/caddy",
		"/usr/bin/caddy",
	}
	caddyConfigCandidates = []string{
		"/opt/homebrew/etc/Caddyfile",
		"/usr/local/etc/Caddyfile",
		"/etc/caddy/Caddyfile",
	}
)

// ListEdgeKinds 返回支持的边缘转发软件列表。
func ListEdgeKinds() []string {
	out := make([]string, len(edgeKinds))
	copy(out, edgeKinds)
	return out
}

// IsKnownKind reports whether kind is one of frp, nginx, caddy.
func IsKnownKind(kind string) bool {
	for _, k := range edgeKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// FrpProxy 表示解析出的 frpc [[proxies]] 配置条目。
type FrpProxy struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	LocalIP    string `json:"localIP"`
	LocalPort  int    `json:"localPort"`
	RemotePort int    `json:"remotePort"`
	Managed    bool   `json:"managed"`
}

type frpBlock struct {
	markerLine int
	startLine  int
	endLine    int
	fields     map[string]string
	managed    bool
}

func parseFrpBlocks(text string) []frpBlock {
	lines := strings.Split(text, "\n")
	blocks := make([]frpBlock, 0)
	var current *frpBlock
	pendingMarker := false
	pendingMarkerLine := -1

	for i, line := range lines {
		if reProxiesHeader.MatchString(line) {
			if current != nil {
				blocks = append(blocks, *current)
			}
			mLine := -1
			if pendingMarker {
				mLine = pendingMarkerLine
			}
			current = &frpBlock{
				markerLine: mLine,
				startLine:  i,
				endLine:    i,
				fields:     make(map[string]string),
				managed:    pendingMarker,
			}
			pendingMarker = false
			pendingMarkerLine = -1
			continue
		}
		if reFrpMarker.MatchString(line) {
			pendingMarker = true
			pendingMarkerLine = i
			continue
		}
		if current == nil {
			continue
		}
		if reAnySection.MatchString(line) {
			blocks = append(blocks, *current)
			current = nil
			continue
		}
		if m := reKeyVal.FindStringSubmatch(line); m != nil {
			val := strings.TrimPrefix(m[2], "\"")
			val = strings.TrimSuffix(val, "\"")
			current.fields[m[1]] = val
		}
		current.endLine = i
	}
	if current != nil {
		blocks = append(blocks, *current)
	}
	return blocks
}

// ListFrpProxies 列出 frpc.toml 中的全部 [[proxies]] 条目。
func ListFrpProxies(text string) []FrpProxy {
	blocks := parseFrpBlocks(text)
	out := make([]FrpProxy, 0, len(blocks))
	for _, b := range blocks {
		localPort, _ := strconv.Atoi(b.fields["localPort"])
		remotePort, _ := strconv.Atoi(b.fields["remotePort"])
		out = append(out, FrpProxy{
			Name:       b.fields["name"],
			Type:       b.fields["type"],
			LocalIP:    b.fields["localIP"],
			LocalPort:  localPort,
			RemotePort: remotePort,
			Managed:    b.managed,
		})
	}
	return out
}

func renderFrpProxy(entry FrpEntry) string {
	localIP := entry.LocalIP
	if localIP == "" {
		localIP = "127.0.0.1"
	}
	return strings.Join([]string{
		fmt.Sprintf("%s%s", frpMarkerPrefix, entry.Name),
		"[[proxies]]",
		fmt.Sprintf("name = %q", entry.Name),
		fmt.Sprintf("type = %q", entry.Type),
		fmt.Sprintf("localIP = %q", localIP),
		fmt.Sprintf("localPort = %d", entry.LocalPort),
		fmt.Sprintf("remotePort = %d", entry.RemotePort),
		"",
	}, "\n")
}

// RemoveFrpProxy 移除指定名称且带 AIH 受管标记的 frpc 转发块。
func RemoveFrpProxy(text, name string) string {
	lines := strings.Split(text, "\n")
	blocks := parseFrpBlocks(text)
	drop := make(map[int]bool)
	for _, b := range blocks {
		if !b.managed || b.fields["name"] != name {
			continue
		}
		if b.markerLine >= 0 && b.markerLine < b.startLine {
			drop[b.markerLine] = true
		}
		for idx := b.startLine; idx <= b.endLine; idx++ {
			drop[idx] = true
		}
		cursor := b.endLine + 1
		for cursor < len(lines) && strings.TrimSpace(lines[cursor]) == "" {
			drop[cursor] = true
			cursor++
		}
	}
	kept := make([]string, 0, len(lines))
	for i, line := range lines {
		if !drop[i] {
			kept = append(kept, line)
		}
	}
	joined := strings.Join(kept, "\n")
	return reMultiBlank.ReplaceAllString(joined, "\n\n")
}

// UpsertFrpProxy 幂等写入一条 AIH 受管 frpc 转发条目。
func UpsertFrpProxy(text string, entry FrpEntry) string {
	base := strings.TrimRight(RemoveFrpProxy(text, entry.Name), " \t\r\n") + "\n"
	return fmt.Sprintf("%s\n%s", base, renderFrpProxy(entry))
}

func normalizeNginxMode(mode string) (string, *EdgeError) {
	v := strings.TrimSpace(mode)
	if v == "" {
		v = "split"
	}
	for _, m := range nginxModes {
		if m == v {
			return v, nil
		}
	}
	return "", &EdgeError{
		Code: "edge_invalid_mode",
		Mode: v,
	}
}

func nginxFileNames(domain string) (streamFile, siteFile string) {
	raw := domain
	if raw == "" {
		raw = "aih"
	}
	safe := reSafeDomain.ReplaceAllString(raw, "_")
	return "aih-edge-stream.conf", fmt.Sprintf("aih-edge-%s.conf", safe)
}

func nginxConfigDirFromVersion(output string) string {
	m := reConfPath.FindStringSubmatch(output)
	if m == nil {
		return ""
	}
	return filepath.Dir(m[1])
}

func nginxStreamConfig(aihPort, tlsTerminatorPort int) string {
	return fmt.Sprintf(`%s
# 一个公网端口同时承载：HTTPS（WebUI，TLS 在这里终结）与 SOCKS5（AIH 中转）+ UDP relay。
# 依据：TLS ClientHello 以 0x16 开头、SOCKS5 以 0x05 开头，用 ssl_preread 分辨（nginx 1.25+）。
stream {
    map $ssl_preread_protocol $aih_443_backend {
        ""      127.0.0.1:%d;          # 非 TLS：SOCKS5 客户端 → AIH 首字节分流
        default 127.0.0.1:%d; # TLS：交给下面本地那个 HTTPS 前端终结
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass $aih_443_backend;
        proxy_connect_timeout 5s;
        proxy_timeout 1h;      # 代理会话可能很长
    }

    # UDP relay（SOCKS5 UDP ASSOCIATE 的数据报）直接透传：QUIC/HTTP3、DoQ、游戏都走这里。
    server {
        listen 443 udp;
        listen [::]:443 udp;
        proxy_pass 127.0.0.1:%d;
        proxy_timeout 60s;
    }
}
`, nginxMarker, aihPort, tlsTerminatorPort, aihPort)
}

func nginxSiteConfig(domain string, aihPort, tlsTerminatorPort int, certDir string) string {
	cert := ""
	if certDir != "" {
		cert = fmt.Sprintf("\n    ssl_certificate     %s/fullchain.pem;\n    ssl_certificate_key %s/privkey.pem;", certDir, certDir)
	}
	return fmt.Sprintf(`%s (%s)
server {
    listen 127.0.0.1:%d ssl;
    server_name %s;%s

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        # SSE / WebSocket / 长轮询：不能缓冲，读超时放长。
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`, nginxSiteMarker, domain, tlsTerminatorPort, domain, cert, aihPort)
}

func nginxHTTPOnlySiteConfig(domain string, aihPort int, certDir string) string {
	cert := ""
	if certDir != "" {
		cert = fmt.Sprintf("\n    ssl_certificate     %s/fullchain.pem;\n    ssl_certificate_key %s/privkey.pem;", certDir, certDir)
	}
	return fmt.Sprintf(`%s (%s)
server {
    listen 443 ssl;
    server_name %s;%s

    location / {
        proxy_pass http://127.0.0.1:%d;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`, nginxSiteMarker, domain, domain, cert, aihPort)
}

func nginxPassthroughStreamConfig(aihPort int) string {
	return fmt.Sprintf(`%s
stream {
    server {
        listen 443;
        listen [::]:443;
        proxy_pass 127.0.0.1:%d;
        proxy_timeout 1h;
    }

    server {
        listen 443 udp;
        listen [::]:443 udp;
        proxy_pass 127.0.0.1:%d;
        proxy_timeout 60s;
    }
}
`, nginxMarker, aihPort, aihPort)
}

func caddySiteConfig(domain string, aihPort int) string {
	return fmt.Sprintf(`# managed by aih (edge-proxy)
%s {
	encode zstd gzip
	reverse_proxy 127.0.0.1:%d {
		flush_interval -1
		header_up X-Forwarded-Host {host}
	}
}
`, domain, aihPort)
}
