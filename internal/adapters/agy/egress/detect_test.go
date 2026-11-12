package egress

import "testing"

// TestApplyScutilProxyOutput 锁住 scutil --proxy 的解析：启用标志、代理地址与
// 优先级素材（HTTPS/HTTP/SOCKS 分别给出）。
func TestApplyScutilProxyOutput(t *testing.T) {
	t.Parallel()
	output := "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
		"<dictionary> {\n" +
		"  HTTPEnable : 1\n" +
		"  HTTPPort : 8080\n" +
		"  HTTPProxy : 127.0.0.1\n" +
		"  HTTPSEnable : 1\n" +
		"  HTTPSPort : 8443\n" +
		"  HTTPSProxy : proxy.local\n" +
		"  SOCKSEnable : 1\n" +
		"  SOCKSPort : 1080\n" +
		"  SOCKSProxy : 127.0.0.1\n" +
		"  ExceptionsList : <array> {\n" +
		"    0 : *.local\n" +
		"  }\n" +
		"}"
	status := SystemProxyStatus{}
	applyScutilProxyOutput(output, &status)
	if !status.Enabled || status.ProbeStatus != "available" {
		t.Fatalf("status = %#v，期望 enabled/available", status)
	}
	if status.HTTPProxy != "http://127.0.0.1:8080" {
		t.Errorf("HTTPProxy = %q", status.HTTPProxy)
	}
	if status.HTTPSProxy != "http://proxy.local:8443" {
		t.Errorf("HTTPSProxy = %q", status.HTTPSProxy)
	}
	if status.SOCKSProxy != "socks5://127.0.0.1:1080" {
		t.Errorf("SOCKSProxy = %q", status.SOCKSProxy)
	}

	socksOnly := SystemProxyStatus{}
	applyScutilProxyOutput("SOCKSEnable : 1\nSOCKSPort : 1080\nSOCKSProxy : 127.0.0.1", &socksOnly)
	if !socksOnly.Enabled || socksOnly.HTTPProxy != "" || socksOnly.HTTPSProxy != "" {
		t.Errorf("socksOnly = %#v", socksOnly)
	}

	disabled := SystemProxyStatus{}
	applyScutilProxyOutput("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 8080", &disabled)
	if disabled.Enabled || disabled.ProbeStatus != "unset" {
		t.Errorf("disabled = %#v，期望未启用", disabled)
	}
}

// TestParseServiceOrder 锁住 networksetup 服务列表解析（名字含空格），
// 以及 Node 对星号行的处理：标记上一条服务为停用。
func TestParseServiceOrder(t *testing.T) {
	t.Parallel()
	output := "An asterisk (*) denotes that a network service is disabled.\n" +
		"(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n\n" +
		"(2) Thunderbolt Bridge\n(Hardware Port: Thunderbolt Bridge, Device: bridge0)\n"
	services := parseServiceOrder(output)
	if len(services) != 2 || services[0].Name != "Wi-Fi" || services[1].Name != "Thunderbolt Bridge" {
		t.Fatalf("services = %#v", services)
	}

	withDisabled := "(1) Wi-Fi\n(2) Ethernet\n(*) Thunderbolt Bridge\n"
	services = parseServiceOrder(withDisabled)
	if len(services) != 1 || services[0].Name != "Wi-Fi" {
		t.Fatalf("星号行后 services = %#v，期望只保留 Wi-Fi（Node 标记上一条停用）", services)
	}
}

// TestEnabledProxyAddress 锁住 networksetup -get*xproxy 的字段解析。
func TestEnabledProxyAddress(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		output string
		socks  bool
		want   string
	}{
		{
			name:   "HTTP 启用",
			output: "Enabled: Yes\nServer: 127.0.0.1\nPort: 6152\nAuthenticated Proxy Enabled: 0",
			want:   "http://127.0.0.1:6152",
		},
		{
			name:   "SOCKS 启用",
			output: "Enabled: Yes\nServer: 127.0.0.1\nPort: 1080",
			socks:  true,
			want:   "socks5://127.0.0.1:1080",
		},
		{
			name:   "未启用",
			output: "Enabled: No\nServer: 127.0.0.1\nPort: 6152",
			want:   "",
		},
		{
			name:   "缺端口",
			output: "Enabled: Yes\nServer: 127.0.0.1",
			want:   "",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := enabledProxyAddress(testCase.output, testCase.socks); got != testCase.want {
				t.Errorf("enabledProxyAddress() = %q，期望 %q", got, testCase.want)
			}
		})
	}
}

// TestParseTUNOutputs 锁住 detectTun() 的三态判定：interface 命中且
// （route 命中或存在网络内核进程）才是 active。
func TestParseTUNOutputs(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name            string
		interfaceOutput string
		routeOutput     string
		processOutput   string
		wantState       string
		wantOwner       string
	}{
		{
			name:            "interface + route + 空进程表",
			interfaceOutput: "utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n",
			routeOutput:     "default  link#20  utun4\n",
			processOutput:   "",
			wantState:       "active",
		},
		{
			name:            "interface + clash verge 进程",
			interfaceOutput: "utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n",
			processOutput:   "  123 /Applications/Clash Verge.app/mihomo -d /tmp\n",
			wantState:       "active",
			wantOwner:       "clash-verge",
		},
		{
			name:            "sing-box",
			interfaceOutput: "utun2: flags=8051\n",
			processOutput:   "  456 sing-box run -c config.json\n",
			wantState:       "active",
			wantOwner:       "sing-box",
		},
		{
			name:            "未知内核按 external",
			interfaceOutput: "utun9: flags=8051\n",
			processOutput:   "  789 /usr/local/bin/some-vpn\n",
			wantState:       "active",
			wantOwner:       "external",
		},
		{
			name:            "只有 interface",
			interfaceOutput: "utun4: flags=8051\n",
			wantState:       "unknown",
		},
		{
			name:        "只有 route",
			routeOutput: "default  link#20  utun4\n",
			wantState:   "unknown",
		},
		{
			name:            "都没有",
			interfaceOutput: "en0: flags=8863\n",
			routeOutput:     "default  link#4  en0\n",
			processOutput:   "  789 /usr/local/bin/some-vpn\n",
			wantState:       "inactive",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			status := parseTUNOutputs(testCase.interfaceOutput, testCase.routeOutput, testCase.processOutput)
			if status.State != testCase.wantState {
				t.Errorf("State = %q，期望 %q", status.State, testCase.wantState)
			}
			if status.Owner != testCase.wantOwner {
				t.Errorf("Owner = %q，期望 %q", status.Owner, testCase.wantOwner)
			}
		})
	}
}
