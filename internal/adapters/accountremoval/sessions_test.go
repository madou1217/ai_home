package accountremoval_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
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


// accountForTest 构造一个真实的账号快照；占用者探测只用到 Provider 与账号引用。
func accountForTest(t *testing.T, providerID string) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef(testAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
		CLIAccountID: cliAccountID,
		Enabled:      true,
		CreatedAt:    time.Unix(1, 0).UTC(),
		UpdatedAt:    time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}
// fakeKiller 记录被终止的会话，并按需把探测结果改成「服务器已不在」。
type fakeKiller struct {
	killErr error
	killed  []string
	probe   *fakeProbe
	socket  string
}

func (killer *fakeKiller) KillSession(_ context.Context, socket string, session string) error {
	killer.killed = append(killer.killed, socket+"/"+session)
	if killer.killErr != nil {
		return killer.killErr
	}
	if killer.probe != nil {
		killer.probe.snapshots[killer.socket] = accountremoval.SessionSnapshot{ServerAlive: false}
	}
	return nil
}

func newServiceWithKiller(t *testing.T, aiHome string, probe *fakeProbe, killer *fakeKiller) *accountremoval.Service {
	t.Helper()
	service, err := accountremoval.New(accountremoval.Options{
		AIHomeDir: aiHome,
		Probe:     probe,
		Kill:      killer,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return service
}

// TestInspectAccountDeletion 守住占用者上报的三态：活跃、陈旧、探测不确定。
func TestInspectAccountDeletion(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	tests := []struct {
		name        string
		snapshot    accountremoval.SessionSnapshot
		probeErr    error
		wantBlocked int
		wantStale   bool
	}{
		{
			name:        "活跃会话是占用者",
			snapshot:    accountremoval.SessionSnapshot{ServerAlive: true, Sessions: []string{"s-main"}},
			wantBlocked: 1,
		},
		{
			name:      "陈旧登记当场清除",
			snapshot:  accountremoval.SessionSnapshot{ServerAlive: false},
			wantStale: true,
		},
		{
			name:        "探测不确定按占用者上报",
			probeErr:    errors.New("tmux unavailable"),
			wantBlocked: 1,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			aiHome := tempRoot(t)
			paths := writeRegistry(t, aiHome, []registryFixture{accountSessionFixture("s-main")})
			probe := &fakeProbe{
				snapshots: map[string]accountremoval.SessionSnapshot{baseSocket: test.snapshot},
			}
			if test.probeErr != nil {
				probe.errs = map[string]error{baseSocket: test.probeErr}
			}
			service := newServiceWithKiller(t, aiHome, probe, &fakeKiller{})

			account := accountForTest(t, "claude")
			blockers, err := service.InspectAccountDeletion(context.Background(), account)
			if err != nil {
				t.Fatalf("InspectAccountDeletion() error = %v", err)
			}
			if len(blockers) != test.wantBlocked {
				t.Fatalf("blockers = %+v, want %d", blockers, test.wantBlocked)
			}
			if test.wantBlocked == 1 && test.probeErr != nil && !blockers[0].Uncertain {
				t.Fatalf("探测失败必须标记 uncertain: %+v", blockers[0])
			}
			_, statErr := os.Lstat(paths["s-main"])
			if exists := statErr == nil; exists == test.wantStale {
				t.Fatalf("登记存在 = %v, want %v", exists, test.wantStale)
			}
		})
	}
}

// TestInspectAccountDeletionReportsUnregisteredSessions 守住账号 socket 上
// 没有登记的会话也算占用者：登记漏一条不等于没人。
func TestInspectAccountDeletionReportsUnregisteredSessions(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	aiHome := tempRoot(t)
	probe := &fakeProbe{snapshots: map[string]accountremoval.SessionSnapshot{
		baseSocket: {ServerAlive: true, Sessions: []string{"s-orphan"}},
	}}
	service := newServiceWithKiller(t, aiHome, probe, &fakeKiller{})

	blockers, err := service.InspectAccountDeletion(context.Background(), accountForTest(t, "claude"))
	if err != nil {
		t.Fatalf("InspectAccountDeletion() error = %v", err)
	}
	if len(blockers) != 1 {
		t.Fatalf("blockers = %+v", blockers)
	}
	if !blockers[0].Unregistered || blockers[0].Session != "s-orphan" || blockers[0].Socket != baseSocket {
		t.Fatalf("blocker = %+v", blockers[0])
	}
}

// TestReleaseAccountDeletionKillsAndReaps 守住强制释放：杀掉 + 复探 + 清登记。
func TestReleaseAccountDeletionKillsAndReaps(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	aiHome := tempRoot(t)
	paths := writeRegistry(t, aiHome, []registryFixture{accountSessionFixture("s-main")})
	probe := &fakeProbe{snapshots: map[string]accountremoval.SessionSnapshot{
		baseSocket: {ServerAlive: true, Sessions: []string{"s-main"}},
	}}
	killer := &fakeKiller{probe: probe, socket: baseSocket}
	service := newServiceWithKiller(t, aiHome, probe, killer)

	account := accountForTest(t, "claude")
	blockers, err := service.InspectAccountDeletion(context.Background(), account)
	if err != nil || len(blockers) != 1 {
		t.Fatalf("InspectAccountDeletion() = %+v, %v", blockers, err)
	}
	if err := service.ReleaseAccountDeletion(context.Background(), account, blockers); err != nil {
		t.Fatalf("ReleaseAccountDeletion() error = %v", err)
	}
	if len(killer.killed) != 1 || killer.killed[0] != baseSocket+"/s-main" {
		t.Fatalf("killed = %v", killer.killed)
	}
	if _, statErr := os.Lstat(paths["s-main"]); statErr == nil {
		t.Fatal("释放成功后必须清掉登记")
	}
}

// TestReleaseAccountDeletionFailsClosed 守住「复探还在就算没释放」。
func TestReleaseAccountDeletionFailsClosed(t *testing.T) {
	baseSocket := "aih-claude-" + testAccountRef
	aiHome := tempRoot(t)
	writeRegistry(t, aiHome, []registryFixture{accountSessionFixture("s-main")})
	probe := &fakeProbe{snapshots: map[string]accountremoval.SessionSnapshot{
		baseSocket: {ServerAlive: true, Sessions: []string{"s-main"}},
	}}
	// 不改变探测结果的 killer：模拟 kill 了但会话仍在。
	killer := &fakeKiller{}
	service := newServiceWithKiller(t, aiHome, probe, killer)

	account := accountForTest(t, "claude")
	blockers := []accountapp.DeletionBlocker{{
		Kind: "persistent_session", Session: "s-main", Socket: baseSocket,
	}}
	err := service.ReleaseAccountDeletion(context.Background(), account, blockers)
	if !errors.Is(err, accountapp.ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
}

// TestReleaseAccountDeletionRefusesUncertainBlockers 守住「不确定不动手」。
func TestReleaseAccountDeletionRefusesUncertainBlockers(t *testing.T) {
	aiHome := tempRoot(t)
	service := newServiceWithKiller(t, aiHome, &fakeProbe{}, &fakeKiller{})
	account := accountForTest(t, "claude")
	err := service.ReleaseAccountDeletion(context.Background(), account, []accountapp.DeletionBlocker{{
		Kind: "persistent_session", Session: "s-main", Socket: "aih-claude-" + testAccountRef, Uncertain: true,
	}})
	if !errors.Is(err, accountapp.ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
}
