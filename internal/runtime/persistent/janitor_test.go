package persistent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeTmuxRunner struct {
	mu    sync.Mutex
	calls []string
	reply func(cmd string, args []string) (string, string, int, error)
}

func (f *fakeTmuxRunner) Run(_ context.Context, cmd string, args ...string) (string, string, int, error) {
	f.mu.Lock()
	f.calls = append(f.calls, cmd+" "+strings.Join(args, " "))
	f.mu.Unlock()
	return f.reply(cmd, args)
}

func TestTmuxSessionStoreCollectAndClose(t *testing.T) {
	aiHome := t.TempDir()
	ref := "acct_0123456789abcdef0123"
	sock, err := DeriveSocket("codex", ref)
	if err != nil {
		t.Fatal(err)
	}
	if sock != "aih-codex-"+ref {
		t.Fatalf("DeriveSocket() = %q", sock)
	}

	registry, err := NewRegistry(filepath.Join(aiHome, "run"))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Write(context.Background(), Entry{
		Provider:     "codex",
		RuntimeScope: ref,
		AccountRef:   ref,
		Socket:       sock,
		Session:      "s-work",
		Label:        "work",
		CWD:          "/tmp/proj",
		ForwardArgs:  []string{"resume", "t1"},
	}); err != nil {
		t.Fatal(err)
	}

	line := strings.Join([]string{
		"s-work",
		"0",
		"1700000000",
		"/tmp/proj",
		"Codex",
		"codex",
		"node",
		"4242",
		"utf8=1",
		"0",
		"/tmp/proj/sub",
		"",
		"1700001000",
		"1700002000",
	}, sessionListSeparator)

	runner := &fakeTmuxRunner{
		reply: func(cmd string, args []string) (string, string, int, error) {
			joined := strings.Join(args, " ")
			switch {
			case joined == "-V":
				return "tmux 3.4", "", 0, nil
			case strings.Contains(joined, "list-sessions"):
				return line + "\n", "", 0, nil
			case strings.Contains(joined, "kill-session"):
				return "", "", 0, nil
			default:
				return "", "unknown", 1, errors.New("unexpected")
			}
		},
	}

	store := &TmuxSessionStore{
		AIHomeDir: aiHome,
		Registry:  registry,
		Runner:    runner,
		Platform:  "darwin",
		Env:       func(string) string { return "" },
	}
	rows, err := store.CollectSessions(context.Background())
	if err != nil {
		t.Fatalf("CollectSessions() err = %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.Name != "s-work" || row.Label != "work" || row.Live || row.LastActiveAtMS != 1700002000000 || row.LastActivityAtMS != 1700001000000 {
		t.Fatalf("row = %+v", row)
	}

	if err := store.CloseSession(context.Background(), row); err != nil {
		t.Fatalf("CloseSession() err = %v", err)
	}
	remaining, err := registry.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 0 {
		t.Fatalf("registry should be cleared after CloseSession, got %+v", remaining)
	}
	_ = os.RemoveAll(aiHome)
}

type blockingCollector struct {
	started chan struct{}
	release chan struct{}
	rows    []SessionRow
}

func (c *blockingCollector) CollectSessions(context.Context) ([]SessionRow, error) {
	select {
	case c.started <- struct{}{}:
	default:
	}
	<-c.release
	return c.rows, nil
}

type memoryLogger struct {
	mu    sync.Mutex
	infos []string
	warns []string
}

func (l *memoryLogger) Info(msg string) {
	l.mu.Lock()
	l.infos = append(l.infos, msg)
	l.mu.Unlock()
}

func (l *memoryLogger) Warn(msg string) {
	l.mu.Lock()
	l.warns = append(l.warns, msg)
	l.mu.Unlock()
}

func TestJanitorOverlapGuardAndLifecycle(t *testing.T) {
	now := time.UnixMilli(2_000_000_000_000).UTC()
	collector := &blockingCollector{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
		rows: []SessionRow{
			{Name: "expired", Socket: "aih-codex-gateway", LastActiveAtMS: now.Add(-48 * time.Hour).UnixMilli()},
		},
	}
	closer := &stubCloser{}
	logger := &memoryLogger{}

	janitor := NewJanitor(JanitorOptions{
		Collector: collector,
		Closer:    closer,
		Now:       func() time.Time { return now },
		PruneSockets: func(context.Context) (SocketPruneSummary, error) {
			return SocketPruneSummary{Scanned: 2, Removed: 1, Kept: 1}, nil
		},
		Logger: logger,
	})
	// 验证间隔下限钳制。
	if janitor.interval != DefaultJanitorInterval {
		t.Fatalf("interval = %v, want %v", janitor.interval, DefaultJanitorInterval)
	}
	shortJanitor := NewJanitor(JanitorOptions{
		Collector: collector,
		Closer:    closer,
		Interval:  time.Second,
	})
	if shortJanitor.interval != MinJanitorInterval {
		t.Fatalf("shortJanitor.interval = %v, want %v", shortJanitor.interval, MinJanitorInterval)
	}

	firstDone := make(chan JanitorRunResult, 1)
	go func() {
		res, _ := janitor.RunNow(context.Background())
		firstDone <- res
	}()

	<-collector.started
	secondRes, err := janitor.RunNow(context.Background())
	if err != nil || !secondRes.Skipped || secondRes.Reason != "running" {
		t.Fatalf("overlapping RunNow = %+v, err=%v", secondRes, err)
	}
	close(collector.release)

	res := <-firstDone
	if !res.Ran || res.Sessions.Closed != 1 || res.Sockets == nil || res.Sockets.Removed != 1 {
		t.Fatalf("first RunNow result = %+v", res)
	}

	// 启动与优雅关闭不漏 goroutine，不重复 Start。
	janitor.interval = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !janitor.Start(ctx) {
		t.Fatal("Start() = false")
	}
	if janitor.Start(ctx) {
		t.Fatal("duplicate Start() should return false")
	}
	time.Sleep(25 * time.Millisecond)
	if !janitor.Stop() {
		t.Fatal("Stop() = false")
	}
	if janitor.Stop() {
		t.Fatal("duplicate Stop() should return false")
	}
}
