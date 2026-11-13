package network

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

type stubExec struct {
	fn func(command string, args []string) environment.RunResult
}

func (stub stubExec) Run(_ context.Context, command string, args []string, _ environment.ExecOptions) environment.RunResult {
	return stub.fn(command, args)
}

type stubServerCfg struct {
	cfg ServerProxyConfig
}

func (stub stubServerCfg) ReadProxyConfig(context.Context) ServerProxyConfig { return stub.cfg }

func intPtr(v int) *int { return &v }

func TestGetProxyStatusMacAndGatewayRedaction(t *testing.T) {
	exec := stubExec{
		fn: func(command string, args []string) environment.RunResult {
			switch command {
			case "scutil":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n"}
			case "networksetup":
				if len(args) > 0 && args[0] == "-listnetworkserviceorder" {
					return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "(1) Wi-Fi\n"}
				}
				if len(args) >= 2 && args[0] == "-getwebproxy" {
					return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "Enabled: Yes\nServer: 127.0.0.1\nPort: 6152\n"}
				}
				return environment.RunResult{OK: true, ExitCode: intPtr(0)}
			case "git":
				if len(args) >= 3 && args[2] == "http.proxy" {
					return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "http://127.0.0.1:7890\n"}
				}
				if len(args) >= 3 && args[2] == "--get-regexp" {
					return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "http.proxy http://127.0.0.1:7890\n"}
				}
				return environment.RunResult{OK: false, ExitCode: intPtr(1)}
			case "npm":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "null\n"}
			}
			return environment.RunResult{OK: false}
		},
	}

	mgr := NewManager(Options{
		GOOS:         "darwin",
		Exec:         exec,
		LookupEnv:    func(k string) string { if k == "HTTPS_PROXY" { return "http://127.0.0.1:7890" }; return "" },
		ServerConfig: stubServerCfg{cfg: ServerProxyConfig{ProxyURL: "http://user:secret@127.0.0.1:8888", NoProxy: "localhost"}},
	})

	status := mgr.GetProxyStatus(context.Background(), false)
	if !status.OK || !status.Gateway.Redacted || !strings.Contains(status.Gateway.ProxyURL, "***@127.0.0.1:8888") {
		t.Fatalf("expected redacted gateway proxy, got %+v", status.Gateway)
	}
	if !status.System.Enabled || status.System.Source != "networksetup -getwebproxy" || status.System.HTTPProxy != "http://127.0.0.1:6152" {
		t.Fatalf("expected networksetup fallback proxy, got %+v", status.System)
	}
	if status.Tools.Git == nil || status.Tools.Git.HTTPProxy != "http://127.0.0.1:7890" {
		t.Fatalf("expected git proxy report, got %+v", status.Tools.Git)
	}
	if status.Tools.NPM == nil || status.Tools.NPM.ProbeStatus != "unset" {
		t.Fatalf("expected unset npm proxy when null, got %+v", status.Tools.NPM)
	}
}

func TestSetToolProxyValidationAndGitUnset(t *testing.T) {
	exec := stubExec{
		fn: func(command string, args []string) environment.RunResult {
			if command == "git" && len(args) >= 3 && args[2] == "--unset" {
				// git returns exit 5 when key doesn't exist -> treated as ok
				return environment.RunResult{OK: false, ExitCode: intPtr(5)}
			}
			if command == "git" && len(args) >= 3 && args[2] == "http.proxy" {
				return environment.RunResult{OK: false, ExitCode: intPtr(1)}
			}
			return environment.RunResult{OK: true, ExitCode: intPtr(0)}
		},
	}
	mgr := NewManager(Options{GOOS: "darwin", Exec: exec})

	if res := mgr.SetToolProxy(context.Background(), "pip", "http://127.0.0.1:7890"); res.OK || res.Error == nil || *res.Error != "unsupported_proxy_target" {
		t.Fatalf("expected unsupported_proxy_target, got %+v", res)
	}
	if res := mgr.SetToolProxy(context.Background(), "git", "http://user:pass@127.0.0.1:7890"); res.OK || res.Error == nil || *res.Error != "invalid_proxy_url" {
		t.Fatalf("expected invalid_proxy_url for credentials, got %+v", res)
	}
	if res := mgr.SetToolProxy(context.Background(), "git", ""); !res.OK || len(res.Operations) != 2 {
		t.Fatalf("expected git unset exit 5 to succeed, got %+v", res)
	}
}

func TestConnectivityAndNetworkLayer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	nowVal := time.Unix(2000, 0)
	exec := stubExec{
		fn: func(command string, args []string) environment.RunResult {
			switch command {
			case "ifconfig":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "utun4: flags=8051<UP>\n"}
			case "netstat":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "default link#22 UCSIg utun4\n"}
			case "ps":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "123 /Applications/Clash Verge.app/Contents/MacOS/verge-mihomo\n"}
			default:
				return environment.RunResult{OK: false}
			}
		},
	}

	mgr := NewManager(Options{
		GOOS: "darwin",
		Exec: exec,
		Now:  func() time.Time { return nowVal },
		ConnectivityTargets: []ConnectivityTarget{
			{ID: "mock", Name: "Mock", URL: srv.URL, Host: "localhost", Group: "ai"},
		},
		ConnectivityAdapter: func(ctx context.Context, targetURL, route, proxyURL string, _ time.Duration) (int, error) {
			req, _ := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return 0, err
			}
			_ = resp.Body.Close()
			return resp.StatusCode, nil
		},
	})

	badRoute := mgr.TestConnectivity(context.Background(), ConnectivityConfig{Route: "tor"})
	if badRoute.Error != "invalid_route" {
		t.Fatalf("expected invalid_route, got %+v", badRoute)
	}
	badProxy := mgr.TestConnectivity(context.Background(), ConnectivityConfig{Route: "proxy", ProxyURL: "http://192.168.1.2:7890"})
	if badProxy.Error != "invalid_local_http_proxy" {
		t.Fatalf("expected invalid_local_http_proxy, got %+v", badProxy)
	}

	first := mgr.GetConnectivity(context.Background(), ConnectivityConfig{Route: "direct"}, false)
	if !first.OK || first.Cached || len(first.Results) != 1 || !first.Results[0].Reachable {
		t.Fatalf("unexpected first connectivity response: %+v", first)
	}
	if first.NetworkLayer == nil || first.NetworkLayer.EffectiveRoute != "tun" || first.NetworkLayer.Tun.Owner == nil || *first.NetworkLayer.Tun.Owner != "clash-verge" {
		t.Fatalf("expected tun clash-verge detection, got %+v", first.NetworkLayer)
	}

	cached := mgr.GetConnectivity(context.Background(), ConnectivityConfig{Route: "direct"}, false)
	if !cached.Cached || cached.Stale {
		t.Fatalf("expected fresh cached connectivity hit, got cached=%v stale=%v", cached.Cached, cached.Stale)
	}
}
