package egress

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func writePoolState(t *testing.T, aiHomeDir string, document map[string]any) {
	t.Helper()
	directory := filepath.Join(aiHomeDir, "run", "egress-pool")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "state.json"), raw, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func poolBindingResolver(t *testing.T, aiHomeDir string, alive func(int) bool) *Resolver {
	t.Helper()
	return newTestResolver(t, Options{
		AIHomeDir: aiHomeDir,
		PidAlive:  alive,
		ReadBinding: func(context.Context, string) (string, bool, error) {
			return bindingJSON(t, map[string]any{"mode": "pool"}), true, nil
		},
	})
}

// TestResolverPoolSelectsAccountLane 覆盖池的「选节点」：账号车道优先，
// 没有车道的账号用默认出口，非回环车道地址被丢弃。
func TestResolverPoolSelectsAccountLane(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	writePoolState(t, aiHomeDir, map[string]any{
		"version":   1,
		"ownerPid":  111,
		"corePid":   222,
		"proxyUrl":  "http://127.0.0.1:7899",
		"startedAt": 1,
		"lanes": map[string]any{
			"acct_00000000000000000001": "http://127.0.0.1:7901",
			// 非回环地址在 Node 读取时被过滤，等同于该账号没有车道。
			"acct_00000000000000000002": "http://10.0.0.8:7902",
		},
	})
	resolver := poolBindingResolver(t, aiHomeDir, func(pid int) bool {
		return pid == 111 || pid == 222
	})
	ctx := context.Background()

	cases := []struct {
		accountRef string
		wantProxy  string
	}{
		{accountRef: "acct_00000000000000000001", wantProxy: "http://127.0.0.1:7901"},
		{accountRef: "acct_00000000000000000002", wantProxy: "http://127.0.0.1:7899"},
		{accountRef: "acct_00000000000000000003", wantProxy: "http://127.0.0.1:7899"},
	}
	for _, testCase := range cases {
		decision, err := resolver.Resolve(ctx, mustAccountRef(t, testCase.accountRef))
		if err != nil {
			t.Fatalf("Resolve(%s) error = %v", testCase.accountRef, err)
		}
		if decision.Target.Source != ModePool || decision.Target.ProxyURL != testCase.wantProxy {
			t.Errorf("Resolve(%s) target = %#v，期望 pool %s", testCase.accountRef, decision.Target, testCase.wantProxy)
		}
	}
}

// TestResolverPoolUnavailable 覆盖池「全部不可用」与配置缺失的 fail-closed：
// 运行文件缺失/损坏、server 或内核进程已退出、地址非回环。
func TestResolverPoolUnavailable(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		document   map[string]any
		writeState bool
		alive      func(int) bool
		wantReason string
	}{
		{
			name:       "运行文件缺失",
			writeState: false,
			alive:      func(int) bool { return true },
			wantReason: reasonPoolServerNotRunning,
		},
		{
			name: "server 进程已退出",
			document: map[string]any{
				"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:7899",
			},
			writeState: true,
			alive:      func(pid int) bool { return pid == 222 },
			wantReason: reasonPoolServerNotRunning,
		},
		{
			name: "内核进程已退出",
			document: map[string]any{
				"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:7899",
			},
			writeState: true,
			alive:      func(pid int) bool { return pid == 111 },
			wantReason: reasonPoolCoreExited,
		},
		{
			name: "默认出口非回环（全不可用）",
			document: map[string]any{
				"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://10.0.0.8:7899",
				"lanes": map[string]any{"acct_00000000000000000001": "http://10.0.0.9:7901"},
			},
			writeState: true,
			alive:      func(int) bool { return true },
			wantReason: reasonPoolServerNotRunning,
		},
		{
			name: "版本不符",
			document: map[string]any{
				"version": 2, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:7899",
			},
			writeState: true,
			alive:      func(int) bool { return true },
			wantReason: reasonPoolServerNotRunning,
		},
		{
			name: "缺 pid",
			document: map[string]any{
				"version": 1, "proxyUrl": "http://127.0.0.1:7899",
			},
			writeState: true,
			alive:      func(int) bool { return true },
			wantReason: reasonPoolServerNotRunning,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			aiHomeDir := t.TempDir()
			if testCase.writeState {
				writePoolState(t, aiHomeDir, testCase.document)
			}
			resolver := poolBindingResolver(t, aiHomeDir, testCase.alive)
			_, err := resolver.Resolve(context.Background(), mustAccountRef(t, "acct_00000000000000000001"))
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != ErrorPoolNotReady {
				t.Fatalf("Resolve() error = %v，期望 egress_pool_not_ready", err)
			}
			if failure.Reason != testCase.wantReason {
				t.Errorf("reason = %q，期望 %q", failure.Reason, testCase.wantReason)
			}
		})
	}
}

// TestResolverPoolCorruptStateFile 覆盖损坏 JSON：Node 的 readEgressPoolState
// 把它当「没有状态」，所以 reason 是 server_not_running。
func TestResolverPoolCorruptStateFile(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	directory := filepath.Join(aiHomeDir, "run", "egress-pool")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "state.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := poolBindingResolver(t, aiHomeDir, func(int) bool { return true })
	_, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != ErrorPoolNotReady || failure.Reason != reasonPoolServerNotRunning {
		t.Fatalf("Resolve() error = %v，期望 egress_pool_not_ready/server_not_running", err)
	}
}

// TestReadPoolStateAcceptsNumericStringPIDs 验证 toPid() 的数字字符串兼容
// （Node Number("111") = 111）。
func TestReadPoolStateAcceptsNumericStringPIDs(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	writePoolState(t, aiHomeDir, map[string]any{
		"version": 1, "ownerPid": "111", "corePid": "222", "proxyUrl": "http://127.0.0.1:7899",
	})
	state, ok := readPoolStateFile(aiHomeDir)
	if !ok {
		t.Fatal("readPoolStateFile() = false，期望 true")
	}
	if state.OwnerPID != 111 || state.CorePID != 222 {
		t.Errorf("pids = %d/%d，期望 111/222", state.OwnerPID, state.CorePID)
	}
}

// TestResolverPoolInvalidProxyPort 验证文件里出现 0 端口时给出明确原因：
// 池读到了，但地址不能作为出站端口使用。
func TestResolverPoolInvalidProxyPort(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	writePoolState(t, aiHomeDir, map[string]any{
		"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:0",
	})
	resolver := poolBindingResolver(t, aiHomeDir, func(int) bool { return true })
	_, err := resolver.Resolve(context.Background(), testAccountRef(t, 1))
	var failure *Error
	if !errors.As(err, &failure) || failure.Code != ErrorPoolNotReady {
		t.Fatalf("Resolve() error = %v，期望 egress_pool_not_ready", err)
	}
	if failure.Reason != "egress_pool_proxy_url_invalid" {
		t.Errorf("reason = %q，期望 egress_pool_proxy_url_invalid", failure.Reason)
	}
}

// TestPoolStateFileIsReadPerCall 验证出口变更不需要重启：每次解析都重新读文件。
func TestPoolStateFileIsReadPerCall(t *testing.T) {
	t.Parallel()
	aiHomeDir := t.TempDir()
	writePoolState(t, aiHomeDir, map[string]any{
		"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:7899",
	})
	resolver := poolBindingResolver(t, aiHomeDir, func(int) bool { return true })
	accountRef := testAccountRef(t, 1)

	decision, err := resolver.Resolve(context.Background(), accountRef)
	if err != nil || decision.Target.ProxyURL != "http://127.0.0.1:7899" {
		t.Fatalf("首次 Resolve() = %#v, %v", decision, err)
	}
	writePoolState(t, aiHomeDir, map[string]any{
		"version": 1, "ownerPid": 111, "corePid": 222, "proxyUrl": "http://127.0.0.1:7900",
	})
	decision, err = resolver.Resolve(context.Background(), accountRef)
	if err != nil || decision.Target.ProxyURL != "http://127.0.0.1:7900" {
		t.Fatalf("二次 Resolve() = %#v, %v，期望读到新出口", decision, err)
	}
}
