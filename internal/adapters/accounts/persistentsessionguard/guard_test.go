package persistentsessionguard

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestGuardAllowsAccountWithoutRegistryEntries 验证没有持久会话登记时不探测 tmux。
func TestGuardAllowsAccountWithoutRegistryEntries(t *testing.T) {
	t.Parallel()

	runner := &sessionCommandRunnerStub{t: t, unexpected: true}
	guard := newGuard(t.TempDir(), runner)
	if err := guard.AssertAccountDeletable(
		context.Background(),
		testAccountRef(t),
	); err != nil {
		t.Fatalf("AssertAccountDeletable() error = %v", err)
	}
}

// TestGuardBlocksLiveExactSession 验证登记中的精确 tmux 会话仍存在时失败关闭。
func TestGuardBlocksLiveExactSession(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	accountRef := testAccountRef(t)
	entryPath := writeRegistryEntry(t, home, accountRef, "codex", "p-live")
	runner := &sessionCommandRunnerStub{
		t: t,
		results: map[string]commandResult{
			"aih-codex-" + accountRef.String(): {
				exitCode: 0,
				stdout:   "p-live\np-other\n",
			},
		},
	}
	guard := newGuard(home, runner)

	err := guard.AssertAccountDeletable(context.Background(), accountRef)
	if !errors.Is(err, accountapp.ErrAccountRuntimeActive) {
		t.Fatalf("AssertAccountDeletable() error = %v", err)
	}
	if _, statErr := os.Stat(entryPath); statErr != nil {
		t.Fatalf("活跃会话登记被删除: %v", statErr)
	}
}

// TestGuardRemovesVerifiedStaleEntries 验证 tmux server 不存在或精确会话已退出时
// 清理登记并允许删除账号。
func TestGuardRemovesVerifiedStaleEntries(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		result commandResult
	}{
		{
			name: "tmux server 不存在",
			result: commandResult{
				exitCode: 1,
				stderr:   "no server running on /tmp/tmux-test/default",
			},
		},
		{
			name: "精确会话不存在",
			result: commandResult{
				exitCode: 0,
				stdout:   "p-another\n",
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			home := t.TempDir()
			accountRef := testAccountRef(t)
			entryPath := writeRegistryEntry(t, home, accountRef, "claude", "p-stale")
			runner := &sessionCommandRunnerStub{
				t: t,
				results: map[string]commandResult{
					"aih-claude-" + accountRef.String(): test.result,
				},
			}
			guard := newGuard(home, runner)

			if err := guard.AssertAccountDeletable(
				context.Background(),
				accountRef,
			); err != nil {
				t.Fatalf("AssertAccountDeletable() error = %v", err)
			}
			if _, err := os.Stat(entryPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("过期会话登记仍存在: %v", err)
			}
		})
	}
}

// TestGuardFailsClosedWhenRuntimeCannotBeVerified 验证登记存在时，缺少 tmux、
// 非可信退出或损坏登记都不能放行数据库删除。
func TestGuardFailsClosedWhenRuntimeCannotBeVerified(t *testing.T) {
	t.Parallel()

	t.Run("tmux 不可用", func(t *testing.T) {
		home := t.TempDir()
		accountRef := testAccountRef(t)
		entryPath := writeRegistryEntry(t, home, accountRef, "codex", "p-unverified")
		guard := newGuard(home, &sessionCommandRunnerStub{
			t:       t,
			lookErr: errors.New("tmux missing"),
		})
		assertRuntimeUnverifiable(t, guard, accountRef)
		if _, err := os.Stat(entryPath); err != nil {
			t.Fatalf("未确认登记被删除: %v", err)
		}
	})

	t.Run("tmux 非可信退出", func(t *testing.T) {
		home := t.TempDir()
		accountRef := testAccountRef(t)
		writeRegistryEntry(t, home, accountRef, "codex", "p-error")
		guard := newGuard(home, &sessionCommandRunnerStub{
			t: t,
			results: map[string]commandResult{
				"aih-codex-" + accountRef.String(): {
					exitCode: 2,
					stderr:   "permission denied",
				},
			},
		})
		assertRuntimeUnverifiable(t, guard, accountRef)
	})

	t.Run("登记损坏", func(t *testing.T) {
		home := t.TempDir()
		directory := filepath.Join(home, "run", "persistent-sessions")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatalf("MkdirAll() error = %v", err)
		}
		if err := os.WriteFile(
			filepath.Join(directory, "broken.json"),
			[]byte("{invalid"),
			0o600,
		); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		guard := newGuard(home, &sessionCommandRunnerStub{t: t, unexpected: true})
		assertRuntimeUnverifiable(t, guard, testAccountRef(t))
	})
}

func assertRuntimeUnverifiable(
	t *testing.T,
	guard *Guard,
	accountRef accountcore.AccountRef,
) {
	t.Helper()
	err := guard.AssertAccountDeletable(context.Background(), accountRef)
	if !errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable) {
		t.Fatalf("AssertAccountDeletable() error = %v", err)
	}
}

type sessionCommandRunnerStub struct {
	t          *testing.T
	results    map[string]commandResult
	lookErr    error
	unexpected bool
}

func (runner *sessionCommandRunnerStub) LookPath(string) (string, error) {
	if runner.unexpected {
		runner.t.Fatal("没有匹配登记时不应探测 tmux")
	}
	if runner.lookErr != nil {
		return "", runner.lookErr
	}
	return "/test/bin/tmux", nil
}

func (runner *sessionCommandRunnerStub) Run(
	_ context.Context,
	_ string,
	arguments ...string,
) (commandResult, error) {
	if runner.unexpected {
		runner.t.Fatal("没有匹配登记时不应执行 tmux")
	}
	if len(arguments) != 6 ||
		arguments[0] != "-u" ||
		arguments[1] != "-L" ||
		arguments[3] != "list-sessions" ||
		arguments[4] != "-F" ||
		arguments[5] != "#{session_name}" {
		runner.t.Fatalf("tmux arguments = %#v", arguments)
	}
	result, found := runner.results[arguments[2]]
	if !found {
		runner.t.Fatalf("缺少 socket %s 的测试结果", arguments[2])
	}
	return result, nil
}

func writeRegistryEntry(
	t *testing.T,
	home string,
	accountRef accountcore.AccountRef,
	providerID string,
	session string,
) string {
	t.Helper()
	socket := "aih-" + providerID + "-" + accountRef.String()
	directory := filepath.Join(home, "run", "persistent-sessions")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	document, err := json.Marshal(map[string]any{
		"provider":     providerID,
		"runtimeScope": accountRef.String(),
		"gateway":      false,
		"accountRef":   accountRef.String(),
		"socket":       socket,
		"session":      session,
		"cwd":          home,
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	entryPath := filepath.Join(directory, socket+"--"+session+".json")
	if err := os.WriteFile(entryPath, document, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	return entryPath
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}
