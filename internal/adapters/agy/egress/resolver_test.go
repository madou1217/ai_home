package egress

import (
	"context"
	"errors"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func mustAccountRef(t *testing.T, value string) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q) error = %v", value, err)
	}
	return accountRef
}

func testAccountRef(t *testing.T, index int) accountcore.AccountRef {
	t.Helper()
	return mustAccountRef(t, "acct_0000000000000000000"+string(rune('0'+index)))
}

// seedBinding 用 Node 的键格式写 app-state.db，验证 Go 读取口与 Node 同库同键。
func seedBinding(t *testing.T, aiHomeDir string, accountRef accountcore.AccountRef, raw string) {
	t.Helper()
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if err := appstate.WriteKV(
		context.Background(),
		databasePath,
		"account:egress:"+accountRef.String(),
		raw,
		1,
	); err != nil {
		t.Fatalf("WriteKV() error = %v", err)
	}
}

func staticDetectors() (SystemProxyDetector, TUNDetector) {
	return func(context.Context) (SystemProxyStatus, error) {
			return SystemProxyStatus{Enabled: false, ProbeStatus: "unset"}, nil
		}, func(context.Context) (TUNStatus, error) {
			return TUNStatus{State: "inactive"}, nil
		}
}

func newTestResolver(t *testing.T, options Options) *Resolver {
	t.Helper()
	if options.Platform == "" {
		options.Platform = "darwin"
	}
	systemProxy, tun := staticDetectors()
	if options.DetectSystemProxy == nil {
		options.DetectSystemProxy = systemProxy
	}
	if options.DetectTUN == nil {
		options.DetectTUN = tun
	}
	if options.PidAlive == nil {
		options.PidAlive = func(int) bool { return true }
	}
	return NewResolver(options)
}

// TestResolverReadsBindingFromAppState 验证 Go 与 Node 共用 account:egress:<ref>
// 键：未绑定保持原网络策略，direct/url 解析成具体目标。
func TestResolverReadsBindingFromAppState(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	directRef := testAccountRef(t, 1)
	urlRef := testAccountRef(t, 2)
	emptyRef := testAccountRef(t, 3)
	seedBinding(t, aiHomeDir, directRef, bindingJSON(t, map[string]any{"mode": "direct"}))
	seedBinding(t, aiHomeDir, urlRef, bindingJSON(t, map[string]any{"mode": "url", "proxyUrl": "127.0.0.1:7890"}))
	seedBinding(t, aiHomeDir, emptyRef, "")

	resolver := newTestResolver(t, Options{AIHomeDir: aiHomeDir})
	ctx := context.Background()

	decision, err := resolver.Resolve(ctx, directRef)
	if err != nil {
		t.Fatalf("Resolve(direct) error = %v", err)
	}
	if !decision.Bound || !decision.Target.Direct || decision.Target.ProxyURL != "" {
		t.Errorf("direct decision = %#v", decision)
	}

	decision, err = resolver.Resolve(ctx, urlRef)
	if err != nil {
		t.Fatalf("Resolve(url) error = %v", err)
	}
	if !decision.Bound || decision.Target.Direct || decision.Target.ProxyURL != "http://127.0.0.1:7890" {
		t.Errorf("url decision = %#v", decision)
	}

	decision, err = resolver.Resolve(ctx, testAccountRef(t, 4))
	if err != nil || decision.Bound {
		t.Errorf("未绑定账号 decision = %#v, err = %v，期望 unbound", decision, err)
	}
	decision, err = resolver.Resolve(ctx, emptyRef)
	if err != nil || decision.Bound {
		t.Errorf("空值绑定 decision = %#v, err = %v，期望 unbound（Node 把空值视为无记录）", decision, err)
	}
}

// TestResolverInvalidAccountRefIsUnbound 对应 Node 对空 accountRef 的 bound:false。
func TestResolverInvalidAccountRefIsUnbound(t *testing.T) {
	t.Parallel()
	resolver := newTestResolver(t, Options{AIHomeDir: t.TempDir()})
	decision, err := resolver.Resolve(context.Background(), accountcore.AccountRef("not-a-ref"))
	if err != nil || decision.Bound {
		t.Fatalf("Resolve(invalid) = %#v, %v，期望 unbound", decision, err)
	}
}

// TestResolverWithoutStorageContextIsUnbound 对应 Node 没有 fs/aiHomeDir 时的
// bound:false：不能去读默认数据目录。
func TestResolverWithoutStorageContextIsUnbound(t *testing.T) {
	t.Parallel()
	resolver := NewResolver(Options{Platform: "darwin"})
	decision, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
	if err != nil || decision.Bound {
		t.Fatalf("Resolve(no storage) = %#v, %v，期望 unbound", decision, err)
	}
}

// TestResolverBindingFailuresFailClosed 锁住损坏记录的 fail-closed 语义：
// 不能把「读不懂」解释成「未绑定」而回落到全局代理。
func TestResolverBindingFailuresFailClosed(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		raw      string
		wantCode string
	}{
		{
			name:     "未知模式",
			raw:      bindingJSON(t, map[string]any{"mode": "magic"}),
			wantCode: ErrorBindingReadFailed,
		},
		{
			name:     "损坏 JSON",
			raw:      "{",
			wantCode: ErrorBindingReadFailed,
		},
		{
			name:     "已下线 node 模式",
			raw:      bindingJSON(t, map[string]any{"mode": "node", "nodeId": "abc"}),
			wantCode: ErrorModeRetired,
		},
		{
			name:     "url 地址非法",
			raw:      bindingJSON(t, map[string]any{"mode": "url", "proxyUrl": "ftp://127.0.0.1:21"}),
			wantCode: "proxy_scheme_unsupported",
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			resolver := newTestResolver(t, Options{
				ReadBinding: func(context.Context, string) (string, bool, error) {
					return testCase.raw, true, nil
				},
			})
			decision, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
			var failure *Error
			if !errors.As(err, &failure) {
				t.Fatalf("Resolve() error = %v，期望 *Error", err)
			}
			if failure.Code != testCase.wantCode {
				t.Errorf("error code = %q，期望 %q", failure.Code, testCase.wantCode)
			}
			if decision.Bound {
				t.Errorf("失败时 decision = %#v，期望零值", decision)
			}
		})
	}
}

// TestResolverReadBindingError 验证 app-state 读取失败按 egress_binding_read_failed 处理。
func TestResolverReadBindingError(t *testing.T) {
	t.Parallel()
	resolver := newTestResolver(t, Options{
		ReadBinding: func(context.Context, string) (string, bool, error) {
			return "", false, errors.New("database is locked")
		},
	})
	_, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != ErrorBindingReadFailed {
		t.Fatalf("Resolve() error = %v，期望 egress_binding_read_failed", err)
	}
	if !strings.Contains(failure.Reason, "database is locked") {
		t.Errorf("reason = %q，期望包含原始错误", failure.Reason)
	}
}

// TestResolverPlatformGate 对应 Node resolveEgressTarget 的平台检查：非 macOS 一律
// not_supported，连 direct 也不例外。
func TestResolverPlatformGate(t *testing.T) {
	t.Parallel()
	for _, platform := range []string{"windows", "linux"} {
		platform := platform
		t.Run(platform, func(t *testing.T) {
			t.Parallel()
			resolver := newTestResolver(t, Options{
				Platform: platform,
				ReadBinding: func(context.Context, string) (string, bool, error) {
					return bindingJSON(t, map[string]any{"mode": "direct"}), true, nil
				},
			})
			_, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != ErrorNotSupported {
				t.Fatalf("Resolve() error = %v，期望 not_supported", err)
			}
			if failure.Platform != platform {
				t.Errorf("platform = %q，期望 %q", failure.Platform, platform)
			}
		})
	}
}

// TestResolverSystemProxy 覆盖系统代理的优先级与失败分支（Node
// resolveSystemProxyTarget）：HTTPS > HTTP > SOCKS5，探测失败 fail-closed。
func TestResolverSystemProxy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		detector  SystemProxyDetector
		wantProxy string
		wantCode  string
	}{
		{
			name: "HTTPS 优先",
			detector: func(context.Context) (SystemProxyStatus, error) {
				return SystemProxyStatus{
					Enabled:    true,
					HTTPProxy:  "http://127.0.0.1:8080",
					HTTPSProxy: "http://127.0.0.1:8443",
					SOCKSProxy: "socks5://127.0.0.1:1080",
				}, nil
			},
			wantProxy: "http://127.0.0.1:8443",
		},
		{
			name: "HTTPS 缺失时用 HTTP",
			detector: func(context.Context) (SystemProxyStatus, error) {
				return SystemProxyStatus{
					Enabled:    true,
					HTTPProxy:  "http://127.0.0.1:8080",
					SOCKSProxy: "socks5://127.0.0.1:1080",
				}, nil
			},
			wantProxy: "http://127.0.0.1:8080",
		},
		{
			name: "只有 SOCKS",
			detector: func(context.Context) (SystemProxyStatus, error) {
				return SystemProxyStatus{Enabled: true, SOCKSProxy: "socks5://127.0.0.1:1080"}, nil
			},
			wantProxy: "socks5://127.0.0.1:1080",
		},
		{
			name: "启用但没有可用地址",
			detector: func(context.Context) (SystemProxyStatus, error) {
				return SystemProxyStatus{Enabled: true, ProbeStatus: "available"}, nil
			},
			wantCode: ErrorSystemProxyUnavailable,
		},
		{
			name: "探测命令失败",
			detector: func(context.Context) (SystemProxyStatus, error) {
				return SystemProxyStatus{}, errors.New("scutil failed")
			},
			wantCode: ErrorSystemProxyUnavailable,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			resolver := newTestResolver(t, Options{
				ReadBinding: func(context.Context, string) (string, bool, error) {
					return bindingJSON(t, map[string]any{"mode": "system"}), true, nil
				},
				DetectSystemProxy: testCase.detector,
			})
			decision, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
			if testCase.wantCode != "" {
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != testCase.wantCode {
					t.Fatalf("Resolve() error = %v，期望 %s", err, testCase.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if decision.Target.ProxyURL != testCase.wantProxy {
				t.Errorf("ProxyURL = %q，期望 %q", decision.Target.ProxyURL, testCase.wantProxy)
			}
		})
	}
}

// TestResolverTUN 覆盖 TUN 的 active/inactive/unknown 三态：只有 active 才允许直连。
func TestResolverTUN(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		detector TUNDetector
		wantCode string
	}{
		{
			name: "active 直连",
			detector: func(context.Context) (TUNStatus, error) {
				return TUNStatus{State: "ACTIVE", Owner: "mihomo"}, nil
			},
		},
		{
			name: "inactive",
			detector: func(context.Context) (TUNStatus, error) {
				return TUNStatus{State: "inactive"}, nil
			},
			wantCode: ErrorTUNInactive,
		},
		{
			name: "unknown",
			detector: func(context.Context) (TUNStatus, error) {
				return TUNStatus{State: "unknown"}, nil
			},
			wantCode: ErrorTUNStateUnknown,
		},
		{
			name: "空状态按 unknown",
			detector: func(context.Context) (TUNStatus, error) {
				return TUNStatus{}, nil
			},
			wantCode: ErrorTUNStateUnknown,
		},
		{
			name: "探测失败",
			detector: func(context.Context) (TUNStatus, error) {
				return TUNStatus{}, errors.New("ifconfig failed")
			},
			wantCode: ErrorTUNStateUnknown,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			resolver := newTestResolver(t, Options{
				ReadBinding: func(context.Context, string) (string, bool, error) {
					return bindingJSON(t, map[string]any{"mode": "tun"}), true, nil
				},
				DetectTUN: testCase.detector,
			})
			decision, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
			if testCase.wantCode != "" {
				var failure *Error
				if !errors.As(err, &failure) || failure.Code != testCase.wantCode {
					t.Fatalf("Resolve() error = %v，期望 %s", err, testCase.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if !decision.Target.Direct || decision.Target.ProxyURL != "" || decision.Target.Source != ModeTUN {
				t.Errorf("tun target = %#v，期望 direct", decision.Target)
			}
		})
	}
}
