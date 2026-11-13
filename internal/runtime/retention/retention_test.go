package retention

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestResolveEnvPolicies(t *testing.T) {
	t.Parallel()

	env := map[string]string{
		"AIH_LOG_MAX_BYTES":          "4096",
		"AIH_LOG_KEEP_DAYS":          "3",
		"AIH_RUNTIME_RETENTION_DAYS": "7",
	}
	getenv := func(k string) string { return env[k] }
	keepDays := ResolveKeepDays(getenv)
	if ResolveMaxBytes(getenv) != 4096 || keepDays != 3 {
		t.Fatalf("unexpected resolved log params: bytes=%d keep=%d", ResolveMaxBytes(getenv), keepDays)
	}
	if gotAge := ResolveMaxAge(getenv, keepDays); gotAge != 3*DayDuration {
		t.Fatalf("ResolveMaxAge() = %v, want %v", gotAge, 3*DayDuration)
	}
	env["AIH_LOG_MAX_AGE_DAYS"] = "5"
	if gotAge := ResolveMaxAge(getenv, keepDays); gotAge != 5*DayDuration {
		t.Fatalf("explicit ResolveMaxAge() = %v, want %v", gotAge, 5*DayDuration)
	}
	if ResolveRetentionDays(getenv) != 7 {
		t.Fatalf("ResolveRetentionDays() = %d, want 7", ResolveRetentionDays(getenv))
	}
}

func TestSweepLogsTrimDatedAndAgePruning(t *testing.T) {
	t.Parallel()

	logsDir := filepath.Join(t.TempDir(), "logs")
	subDir := filepath.Join(logsDir, "nested")
	if err := os.MkdirAll(subDir, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.Local)

	// 1) 超大活跃日志应原地从首行换行之后截断保留尾部
	activeLog := filepath.Join(logsDir, "server.log")
	if err := os.WriteFile(activeLog, []byte("first-line-truncated\nsecond-line-kept\nthird-line-kept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(activeLog, now, now)

	// 2) 按文件名日期超期（cutoff = 2026-11-03，即使 mtime 是今天也该按日期清理）
	expiredDated := filepath.Join(subDir, "audit.jsonl.2026-10-30")
	if err := os.WriteFile(expiredDated, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(expiredDated, now, now)

	// 3) 尚在保留期内的按天归档文件
	keptDated := filepath.Join(subDir, "audit.jsonl.2026-11-10")
	if err := os.WriteFile(keptDated, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(keptDated, now, now)

	// 4) mtime 超过 maxAge 的闲置日志
	staleLog := filepath.Join(logsDir, "idle.log")
	if err := os.WriteFile(staleLog, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldTime := now.Add(-11 * DayDuration)
	_ = os.Chtimes(staleLog, oldTime, oldTime)

	report := SweepLogs(logsDir, LogSweepOptions{
		MaxBytes: 36,
		KeepDays: 10,
		MaxAge:   10 * DayDuration,
		Now:      func() time.Time { return now },
	})
	if report.Removed != 2 || report.Trimmed != 1 || report.Changed != 3 {
		t.Fatalf("SweepLogs() report = %+v, want removed=2 trimmed=1 changed=3", report)
	}
	trimmedData, err := os.ReadFile(activeLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(trimmedData) != "second-line-kept\nthird-line-kept\n" {
		t.Fatalf("unexpected trimmed content = %q", string(trimmedData))
	}
	if _, err := os.Stat(expiredDated); !os.IsNotExist(err) {
		t.Fatalf("expected expired dated log removed, err=%v", err)
	}
	if _, err := os.Stat(staleLog); !os.IsNotExist(err) {
		t.Fatalf("expected stale log removed, err=%v", err)
	}
	if _, err := os.Stat(keptDated); err != nil {
		t.Fatalf("expected kept dated log preserved, err=%v", err)
	}
}

func TestSweepRuntimeDirsSafetyAndOrphanReclaim(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.Local)
	staleTime := now.Add(-15 * DayDuration)
	freshTime := now.Add(-1 * time.Hour)

	makeFile := func(rel string, body []byte, mtime time.Time) string {
		full := filepath.Join(aiHome, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_ = os.Chtimes(full, mtime, mtime)
		return full
	}

	// 1) 已删除账号的 chat-harness 即使 mtime 很新也立即孤儿回收
	orphanDir := filepath.Join(aiHome, "run", "chat-harness", "acct_deleted111111111111")
	makeFile(filepath.Join("run", "chat-harness", "acct_deleted111111111111", "config.toml"), []byte("x"), freshTime)

	// 2) 活跃账号但内部含私有 thread_history_1.sqlite 真文件：即便超期也不删
	privateDir := filepath.Join(aiHome, "run", "chat-harness", "acct_active2222222222222")
	makeFile(filepath.Join("run", "chat-harness", "acct_active2222222222222", ".codex", "thread_history_1.sqlite"), []byte("sqlite"), staleTime)
	_ = os.Chtimes(filepath.Join(privateDir, ".codex"), staleTime, staleTime)
	_ = os.Chtimes(privateDir, staleTime, staleTime)

	// 3) 活跃账号、普通超期 harness -> 按 stale-harness 回收
	staleHarnessDir := filepath.Join(aiHome, "run", "chat-harness", "acct_stale33333333333333")
	makeFile(filepath.Join("run", "chat-harness", "acct_stale33333333333333", "config.toml"), []byte("stale"), staleTime)
	_ = os.Chtimes(staleHarnessDir, staleTime, staleTime)

	// 4) 受保护的 currentHome，即便属于 orphan/stale 也不能删
	protectedDir := filepath.Join(aiHome, "run", "login", "codex", "auth_current")
	makeFile(filepath.Join("run", "login", "codex", "auth_current", "tmp.txt"), []byte("keep"), staleTime)
	_ = os.Chtimes(protectedDir, staleTime, staleTime)

	// 5) 过期 login 与 verification
	staleLoginDir := filepath.Join(aiHome, "run", "login", "codex", "auth_old")
	makeFile(filepath.Join("run", "login", "codex", "auth_old", "token.json"), []byte("old"), staleTime)
	_ = os.Chtimes(staleLoginDir, staleTime, staleTime)

	staleVerifyDir := filepath.Join(aiHome, "run", "verification", "run_old")
	makeFile(filepath.Join("run", "verification", "run_old", "out.txt"), []byte("v"), staleTime)
	_ = os.Chtimes(staleVerifyDir, staleTime, staleTime)

	// 首先验证 HasActiveRefs=false 时不会删孤儿目录
	noRefsReport := SweepRuntimeDirs(RuntimeSweepOptions{
		AIHomeDir:     aiHome,
		HasActiveRefs: false,
		CurrentHome:   protectedDir,
		Now:           func() time.Time { return now },
		KeepDays:      10,
	})
	if _, err := os.Stat(orphanDir); err != nil {
		t.Fatalf("orphanDir should NOT be deleted when HasActiveRefs=false, err=%v", err)
	}
	if len(noRefsReport.Removed) != 3 {
		t.Fatalf("expected 3 stale dirs removed on noRefs pass, got %+v", noRefsReport.Removed)
	}

	// 再传入活跃账号列表：acct_deleted 应被立即 orphan-harness 回收
	withRefsReport := SweepRuntimeDirs(RuntimeSweepOptions{
		AIHomeDir: aiHome,
		ActiveAccountRefs: []string{
			"acct_active2222222222222",
			"acct_stale33333333333333",
		},
		HasActiveRefs: true,
		CurrentHome:   protectedDir,
		Now:           func() time.Time { return now },
		KeepDays:      10,
	})
	if _, err := os.Stat(orphanDir); !os.IsNotExist(err) {
		t.Fatalf("expected orphanDir removed when HasActiveRefs=true, err=%v", err)
	}
	if len(withRefsReport.Removed) != 1 || withRefsReport.Removed[0].Reason != "orphan-harness" {
		t.Fatalf("unexpected second pass removals: %+v", withRefsReport.Removed)
	}
	if _, err := os.Stat(privateDir); err != nil {
		t.Fatalf("privateDir with real thread_history_1.sqlite must be preserved, err=%v", err)
	}
	if _, err := os.Stat(protectedDir); err != nil {
		t.Fatalf("protectedDir matching CurrentHome must be preserved, err=%v", err)
	}
}

func TestRetentionDaemonStartupTicksAndSafeRefsError(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.Local)
	orphanDir := filepath.Join(aiHome, "run", "chat-harness", "acct_deleted999999999999")
	if err := os.MkdirAll(orphanDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphanDir, "f"), []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}

	logTickCh := make(chan time.Time, 2)
	runtimeTickCh := make(chan time.Time, 2)
	var failRefs atomic.Bool
	failRefs.Store(true)

	daemon, err := StartDaemon(context.Background(), DaemonOptions{
		AIHomeDir:         aiHome,
		Now:               func() time.Time { return now },
		testLogTickCh:     logTickCh,
		testRuntimeTickCh: runtimeTickCh,
		ActiveRefsProvider: func(context.Context) ([]string, bool, error) {
			if failRefs.Load() {
				return nil, false, errors.New("sqlite busy")
			}
			return []string{"acct_other11111111111111"}, true, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()

	// 启动清扫在 ActiveRefsProvider 报错时不能删 orphanDir
	if _, err := os.Stat(orphanDir); err != nil {
		t.Fatalf("orphanDir must remain while ActiveRefsProvider errors, err=%v", err)
	}
	st := daemon.State()
	if st.LogTickCount != 1 || st.RuntimeTickCount != 1 || st.LastRuntimeError != "sqlite busy" {
		t.Fatalf("unexpected startup daemon state: %+v", st)
	}

	failRefs.Store(false)
	report := daemon.TriggerRuntime(context.Background())
	if len(report.Removed) != 1 || report.Removed[0].Reason != "orphan-harness" {
		t.Fatalf("expected orphanDir removed once ActiveRefsProvider recovers, got %+v", report.Removed)
	}
	if st2 := daemon.State(); st2.RuntimeTickCount != 2 || st2.LastRuntimeError != "" {
		t.Fatalf("expected cleared error and runtimeTickCount=2, got %+v", st2)
	}
}
