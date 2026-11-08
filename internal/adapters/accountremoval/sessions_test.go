package accountremoval_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountremoval"
)

type fakeProbe struct {
	snapshots map[string]accountremoval.SessionSnapshot
	errs      map[string]error
	calls     []string
}

func (probe *fakeProbe) Probe(_ context.Context, socket string) (accountremoval.SessionSnapshot, error) {
	probe.calls = append(probe.calls, socket)
	if err, found := probe.errs[socket]; found {
		return accountremoval.SessionSnapshot{}, err
	}
	return probe.snapshots[socket], nil
}

type registryFixture struct {
	provider     string
	accountRef   string
	runtimeScope string
	socket       string
	session      string
	gateway      bool
}

func accountSessionFixture(session string) registryFixture {
	return registryFixture{
		provider:   "claude",
		accountRef: testAccountRef,
		socket:     "aih-claude-" + testAccountRef,
		session:    session,
	}
}

func writeRegistry(t *testing.T, aiHome string, fixtures []registryFixture) map[string]string {
	t.Helper()
	directory := filepath.Join(aiHome, "run", "persistent-sessions")
	paths := make(map[string]string, len(fixtures))
	for _, fixture := range fixtures {
		provider := fixture.provider
		if provider == "" {
			provider = "claude"
		}
		accountRef := fixture.accountRef
		runtimeScope := fixture.runtimeScope
		if fixture.gateway {
			accountRef = ""
			runtimeScope = "gateway"
		} else if runtimeScope == "" {
			runtimeScope = accountRef
		}
		document, err := json.MarshalIndent(map[string]any{
			"provider":     provider,
			"runtimeScope": runtimeScope,
			"gateway":      fixture.gateway,
			"accountRef":   accountRef,
			"socket":       fixture.socket,
			"session":      fixture.session,
		}, "", "  ")
		if err != nil {
			t.Fatalf("序列化登记: %v", err)
		}
		path := filepath.Join(directory, fixture.socket+"--"+fixture.session+".json")
		writeFile(t, path, string(document)+"\n")
		paths[fixture.session] = path
	}
	return paths
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func TestAssertNoSessionWriters(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	tests := []struct {
		name           string
		entries        []registryFixture
		snapshots      map[string]accountremoval.SessionSnapshot
		probeErrs      map[string]error
		wantErr        error
		wantRemaining  []string
		wantProbeCalls int
	}{
		{
			name: "没有登记直接放行",
		},
		{
			name:    "服务端不存在时清掉陈旧登记",
			entries: []registryFixture{accountSessionFixture("s-main")},
			snapshots: map[string]accountremoval.SessionSnapshot{
				baseSocket: {ServerAlive: false},
			},
			wantProbeCalls: 1,
		},
		{
			name:    "精确会话存活时拒绝删除",
			entries: []registryFixture{accountSessionFixture("s-main")},
			snapshots: map[string]accountremoval.SessionSnapshot{
				baseSocket: {ServerAlive: true, Sessions: []string{"s-main", "s-other"}},
			},
			wantErr:        accountapp.ErrAccountRuntimeActive,
			wantRemaining:  []string{"s-main"},
			wantProbeCalls: 1,
		},
		{
			name:    "服务端存活但精确会话已退出时清理登记",
			entries: []registryFixture{accountSessionFixture("s-main")},
			snapshots: map[string]accountremoval.SessionSnapshot{
				baseSocket: {ServerAlive: true, Sessions: []string{"s-other"}},
			},
			wantProbeCalls: 1,
		},
		{
			name:    "探测无法确认时失败关闭且保留登记",
			entries: []registryFixture{accountSessionFixture("s-main")},
			probeErrs: map[string]error{
				baseSocket: errors.New("tmux probe timeout"),
			},
			wantErr:        accountapp.ErrAccountRuntimeUnverifiable,
			wantRemaining:  []string{"s-main"},
			wantProbeCalls: 1,
		},
		{
			name: "同一 socket 只探测一次",
			entries: []registryFixture{
				accountSessionFixture("s-main"),
				accountSessionFixture("s-second"),
			},
			snapshots: map[string]accountremoval.SessionSnapshot{
				baseSocket: {ServerAlive: true, Sessions: []string{"s-main", "s-second"}},
			},
			wantErr:        accountapp.ErrAccountRuntimeActive,
			wantRemaining:  []string{"s-main", "s-second"},
			wantProbeCalls: 1,
		},
		{
			name: "活跃条目阻塞时同批陈旧条目仍被清理",
			entries: []registryFixture{
				accountSessionFixture("s-main"),
				accountSessionFixture("s-old"),
			},
			snapshots: map[string]accountremoval.SessionSnapshot{
				baseSocket: {ServerAlive: true, Sessions: []string{"s-main"}},
			},
			wantErr:        accountapp.ErrAccountRuntimeActive,
			wantRemaining:  []string{"s-main"},
			wantProbeCalls: 1,
		},
		{
			name: "其他 Provider 的登记不受影响",
			entries: []registryFixture{{
				provider:   "codex",
				accountRef: testAccountRef,
				socket:     "aih-codex-" + testAccountRef,
				session:    "s-codex",
			}},
			wantRemaining: []string{"s-codex"},
		},
		{
			name: "网关登记不参与账号删除",
			entries: []registryFixture{{
				provider: "claude",
				socket:   "aih-claude-gateway",
				session:  "s-gw",
				gateway:  true,
			}},
			wantRemaining: []string{"s-gw"},
		},
		{
			name: "作用域不自洽的登记静默跳过",
			entries: []registryFixture{{
				provider:     "claude",
				accountRef:   testAccountRef,
				runtimeScope: "acct_ffffffffffffffffffff",
				socket:       baseSocket,
				session:      "s-invalid",
			}},
			wantRemaining: []string{"s-invalid"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			aiHome := tempRoot(t)
			probe := &fakeProbe{snapshots: test.snapshots, errs: test.probeErrs}
			paths := writeRegistry(t, aiHome, test.entries)
			service := newService(t, aiHome, probe)

			err := service.AssertNoSessionWriters(context.Background(), "claude", testAccountRef)
			if test.wantErr == nil {
				if err != nil {
					t.Fatalf("不应拒绝删除, err = %v", err)
				}
			} else if !errors.Is(err, test.wantErr) {
				t.Fatalf("错误 = %v, want %v", err, test.wantErr)
			}

			for _, fixture := range test.entries {
				_, statErr := os.Lstat(paths[fixture.session])
				exists := statErr == nil
				wantExists := contains(test.wantRemaining, fixture.session)
				if exists != wantExists {
					t.Fatalf("登记 %s 存在 = %v, want %v (stat err = %v)", fixture.session, exists, wantExists, statErr)
				}
			}
			if len(probe.calls) != test.wantProbeCalls {
				t.Fatalf("探测次数 = %d, want %d (%v)", len(probe.calls), test.wantProbeCalls, probe.calls)
			}
		})
	}
}

func TestAssertNoSessionWritersFailsClosedOnBrokenRegistry(t *testing.T) {
	aiHome := tempRoot(t)
	path := filepath.Join(aiHome, "run", "persistent-sessions", "broken.json")
	writeFile(t, path, "{not json")
	service := newService(t, aiHome, &fakeProbe{})

	err := service.AssertNoSessionWriters(context.Background(), "claude", testAccountRef)
	if !errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable) {
		t.Fatalf("损坏登记必须失败关闭, err = %v", err)
	}
	if _, statErr := os.Lstat(path); statErr != nil {
		t.Fatalf("失败关闭时不能删除登记, stat err = %v", statErr)
	}
}

func TestAssertNoSessionWritersHonorsContext(t *testing.T) {
	aiHome := tempRoot(t)
	writeRegistry(t, aiHome, []registryFixture{accountSessionFixture("s-main")})
	probe := &fakeProbe{}
	service := newService(t, aiHome, probe)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := service.AssertNoSessionWriters(ctx, "claude", testAccountRef); !errors.Is(err, context.Canceled) {
		t.Fatalf("已取消的 Context 必须直接返回, err = %v", err)
	}
	if len(probe.calls) != 0 {
		t.Fatalf("Context 已取消时不应探测: %v", probe.calls)
	}
}

func TestAssertAccountDeletable(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	tests := []struct {
		name      string
		snapshot  accountremoval.SessionSnapshot
		wantErr   error
		wantExist bool
	}{
		{
			name:      "活跃会话阻塞账号删除",
			snapshot:  accountremoval.SessionSnapshot{ServerAlive: true, Sessions: []string{"s-main"}},
			wantErr:   accountapp.ErrAccountRuntimeActive,
			wantExist: true,
		},
		{
			name:     "陈旧会话放行并清理",
			snapshot: accountremoval.SessionSnapshot{ServerAlive: false},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			aiHome := tempRoot(t)
			paths := writeRegistry(t, aiHome, []registryFixture{accountSessionFixture("s-main")})
			probe := &fakeProbe{snapshots: map[string]accountremoval.SessionSnapshot{baseSocket: test.snapshot}}
			service := newService(t, aiHome, probe)

			ref, err := accountcore.ParseAccountRef(testAccountRef)
			if err != nil {
				t.Fatalf("解析账号引用: %v", err)
			}
			err = service.AssertAccountDeletable(context.Background(), ref)
			if test.wantErr == nil {
				if err != nil {
					t.Fatalf("不应拒绝删除, err = %v", err)
				}
			} else if !errors.Is(err, test.wantErr) {
				t.Fatalf("错误 = %v, want %v", err, test.wantErr)
			}
			_, statErr := os.Lstat(paths["s-main"])
			if exists := statErr == nil; exists != test.wantExist {
				t.Fatalf("登记存在 = %v, want %v", exists, test.wantExist)
			}
		})
	}
}
