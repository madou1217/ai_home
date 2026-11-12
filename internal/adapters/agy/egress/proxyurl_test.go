package egress

import "testing"

// TestProxyURLIssueMatchesNodeWhitelist 锁住 Node proxyUrlIssue() 的判定：
// scheme 白名单、简写、凭据/路径/查询串一律拒绝。
func TestProxyURLIssueMatchesNodeWhitelist(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "http 完整地址", input: "http://127.0.0.1:7890", want: ""},
		{name: "host:port 简写", input: "127.0.0.1:7890", want: ""},
		{name: "https", input: "https://proxy.example.com:443", want: ""},
		{name: "socks5", input: "socks5://127.0.0.1:1080", want: ""},
		{name: "socks5h", input: "socks5h://127.0.0.1:1080", want: ""},
		{name: "IPv6 字面量", input: "http://[::1]:8080", want: ""},
		{name: "空值", input: "  ", want: "invalid_proxy_url"},
		{name: "缺端口简写", input: "127.0.0.1", want: "invalid_proxy_url"},
		{name: "ftp 不支持", input: "ftp://127.0.0.1:21", want: "proxy_scheme_unsupported"},
		{name: "socks4 不支持", input: "socks4://127.0.0.1:1080", want: "proxy_scheme_unsupported"},
		{name: "带凭据", input: "http://user:pass@127.0.0.1:8080", want: "invalid_proxy_url"},
		{name: "带路径", input: "http://127.0.0.1:8080/proxy", want: "invalid_proxy_url"},
		{name: "带查询串", input: "http://127.0.0.1:8080?x=1", want: "invalid_proxy_url"},
		{name: "带片段", input: "http://127.0.0.1:8080#frag", want: "invalid_proxy_url"},
		{name: "端口为 0", input: "http://127.0.0.1:0", want: "invalid_proxy_url"},
		{name: "端口越界", input: "http://127.0.0.1:70000", want: "invalid_proxy_url"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := proxyURLIssue(testCase.input); got != testCase.want {
				t.Errorf("proxyURLIssue(%q) = %q，期望 %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestNormalizeProxyURLMatchesNodeHost 锁住归一化：scheme://host[:port]，
// http/https 默认端口被省略（Node 的 URL.host 行为）。
func TestNormalizeProxyURLMatchesNodeHost(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input string
		want  string
	}{
		{input: "127.0.0.1:7890", want: "http://127.0.0.1:7890"},
		{input: " http://127.0.0.1:7890 ", want: "http://127.0.0.1:7890"},
		{input: "http://Proxy.Example.com:8080", want: "http://proxy.example.com:8080"},
		{input: "http://proxy.example.com:80", want: "http://proxy.example.com"},
		{input: "https://proxy.example.com:443", want: "https://proxy.example.com"},
		{input: "socks5://127.0.0.1:1080", want: "socks5://127.0.0.1:1080"},
		{input: "socks5h://127.0.0.1:1080", want: "socks5h://127.0.0.1:1080"},
		{input: "http://[::1]:8080", want: "http://[::1]:8080"},
		{input: "ftp://127.0.0.1:21", want: ""},
		{input: "http://127.0.0.1:0", want: ""},
	}
	for _, testCase := range cases {
		if got := normalizeProxyURL(testCase.input); got != testCase.want {
			t.Errorf("normalizeProxyURL(%q) = %q，期望 %q", testCase.input, got, testCase.want)
		}
	}
}

// TestIsLoopbackHTTPURL 锁住池运行文件的地址约束：只认 http://127.0.0.1:<port>。
func TestIsLoopbackHTTPURL(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input string
		want  bool
	}{
		{input: "http://127.0.0.1:7890", want: true},
		{input: "http://127.0.0.1:0", want: true},
		{input: "https://127.0.0.1:7890", want: false},
		{input: "http://localhost:7890", want: false},
		{input: "http://10.0.0.1:7890", want: false},
		{input: "http://127.0.0.1", want: false},
		{input: "", want: false},
	}
	for _, testCase := range cases {
		if got := isLoopbackHTTPURL(testCase.input); got != testCase.want {
			t.Errorf("isLoopbackHTTPURL(%q) = %v，期望 %v", testCase.input, got, testCase.want)
		}
	}
}
