package peer

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestResolvePeerAIHomeDirSkipsProjectedPaths(t *testing.T) {
	t.Parallel()

	env := map[string]string{
		"HOME":          "/Users/alice/.ai_home/run/auth-projections/codex/acct_1234567890abcdef1234",
		"AIH_HOST_HOME": "/Users/alice",
	}
	getenv := func(k string) string { return env[k] }

	got := ResolvePeerAIHomeDir(
		"/Users/alice/.ai_home/run/auth-projections/codex/acct_1234567890abcdef1234/.ai_home",
		"/Users/alice/.ai_home/run/login/codex/acct_1",
		getenv,
	)
	want := filepath.Join("/Users/alice", ".ai_home")
	if got != want {
		t.Fatalf("ResolvePeerAIHomeDir() = %q, want %q", got, want)
	}

	explicit := "/tmp/custom-ai-home"
	if gotExplicit := ResolvePeerAIHomeDir(explicit, "", getenv); gotExplicit != explicit {
		t.Fatalf("explicit ResolvePeerAIHomeDir() = %q, want %q", gotExplicit, explicit)
	}
}

func TestDispatchDaemonInjectBusyThenQuietSinglePointZeroWait(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	nowMs := atomic.Int64{}
	nowMs.Store(1_700_000_000_000)
	nowFn := func() time.Time { return time.UnixMilli(nowMs.Load()) }

	store := NewDispatchStore(aiHome, StoreOptions{Now: nowFn})
	rec, err := store.CreateMessage(CreateMessageInput{
		From: RecordParty{Name: "sender-pane", Address: "sender-pane"},
		To: RecordParty{
			Channel:  "inject",
			Provider: "codex",
			Name:     "worker-pane",
			Address:  "worker-pane",
			Delivery: &DeliveryTarget{
				CLIName:      "codex",
				RuntimeScope: "gateway",
				SessionName:  "worker-pane",
			},
		},
		Body: "line1\nline2",
	})
	if err != nil {
		t.Fatalf("CreateMessage() error = %v", err)
	}

	var mu sync.Mutex
	var commands [][]string
	activitySec := atomic.Int64{}
	// 最后活动在 200ms 前（< 1200ms 安静期）-> busy
	activitySec.Store((nowMs.Load() - 200) / 1000)

	tickCh := make(chan time.Time, 4)
	daemon, err := StartDispatchDaemon(context.Background(), DispatchDaemonOptions{
		AIHomeDir:  aiHome,
		Batch:      5,
		Now:        nowFn,
		testTickCh: tickCh,
		Delivery: DeliveryOptions{
			TmuxPath: "tmux",
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				mu.Lock()
				commands = append(commands, append([]string(nil), args...))
				mu.Unlock()
				for _, a := range args {
					if a == "display-message" {
						return fmt.Sprintf("%d\n", activitySec.Load()), 0, nil
					}
				}
				return "", 0, nil
			},
		},
	})
	if err != nil {
		t.Fatalf("StartDispatchDaemon() error = %v", err)
	}
	defer daemon.Close()

	// 第一轮：busy，直接退回 pending，不调用 send-keys，也不等安静期
	summary, err := daemon.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick 1 error = %v", err)
	}
	if summary.Attempted != 1 || summary.Pending != 1 || summary.Delivered != 0 {
		t.Fatalf("Tick 1 summary = %+v, want attempted=1 pending=1 delivered=0", summary)
	}
	mu.Lock()
	if len(commands) != 1 || commands[0][3] != "display-message" {
		mu.Unlock()
		t.Fatalf("Tick 1 expected single display-message probe, got %v", commands)
	}
	mu.Unlock()

	// 推进时钟跨过 3s 退避和 1.2s 安静期
	nowMs.Add(5_000)
	summary2, err := daemon.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick 2 error = %v", err)
	}
	if summary2.Attempted != 1 || summary2.Delivered != 1 {
		t.Fatalf("Tick 2 summary = %+v, want attempted=1 delivered=1", summary2)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(commands) != 4 {
		t.Fatalf("expected 4 tmux calls (probe, probe, send-keys text, send-keys Enter), got %d: %v", len(commands), commands)
	}
	textArgs := commands[2]
	if textArgs[len(textArgs)-1] != fmt.Sprintf("[aih-peer #%s from sender-pane | reply: aih peer reply %s] line1\\nline2", ShortMessageID(rec.ID), ShortMessageID(rec.ID)) {
		t.Fatalf("unexpected envelope text arg = %q", textArgs[len(textArgs)-1])
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "peer", "archive", rec.ID+".json")); err != nil {
		t.Fatalf("expected archived record: %v", err)
	}
}

func TestFlushPendingFilterBeforeLimitAndRecoverExpire(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	nowMs := int64(1_700_000_000_000)
	nowFn := func() time.Time { return time.UnixMilli(nowMs) }
	store := NewDispatchStore(aiHome, StoreOptions{
		Now:           nowFn,
		InflightStale: 5 * time.Second,
	})

	// 前 5 条都在未来退避中；第 6 条（m6）已到点，不应被 limit=5 饿死。
	for i := 0; i < 5; i++ {
		rec, err := store.CreateMessage(CreateMessageInput{
			ID: fmt.Sprintf("pm-%032d", i+1),
			To: RecordParty{
				Channel: "inject",
				Delivery: &DeliveryTarget{CLIName: "codex", RuntimeScope: "gateway", SessionName: "s1"},
			},
			Body: "backed-off",
		})
		if err != nil {
			t.Fatal(err)
		}
		claimed, ok, err := store.Claim(rec.ID)
		if err != nil || !ok {
			t.Fatalf("Claim(%s) failed: ok=%v err=%v", rec.ID, ok, err)
		}
		if _, err := store.SettlePending(claimed, "target_busy", 30*time.Second); err != nil {
			t.Fatal(err)
		}
		nowMs++
	}
	readyRec, err := store.CreateMessage(CreateMessageInput{
		ID: "pm-00000000000000000000000000000099",
		To: RecordParty{
			Channel: "inject",
			Delivery: &DeliveryTarget{CLIName: "codex", RuntimeScope: "gateway", SessionName: "s2"},
		},
		Body: "ready-now",
	})
	if err != nil {
		t.Fatal(err)
	}

	// 放一条过期的消息与一条 inflight 孤儿消息。
	oldRec := Record{
		V:         RecordVersion,
		ID:        "pm-00000000000000000000000000000088",
		To:        RecordParty{Channel: "inject", Delivery: &DeliveryTarget{CLIName: "codex", RuntimeScope: "gateway", SessionName: "old"}},
		Body:      "expired",
		CreatedAt: nowMs - int64((25 * time.Hour).Milliseconds()),
		State:     "pending",
		Attempts:  []AttemptRecord{},
	}
	if err := store.writeRecord("pending", oldRec); err != nil {
		t.Fatal(err)
	}
	orphanRec := Record{
		V:         RecordVersion,
		ID:        "pm-00000000000000000000000000000077",
		To:        RecordParty{Channel: "inject", Delivery: &DeliveryTarget{CLIName: "codex", RuntimeScope: "gateway", SessionName: "orphan"}},
		Body:      "orphan",
		CreatedAt: nowMs - 10_000,
		State:     "pending",
		Attempts:  []AttemptRecord{},
	}
	if err := store.writeRecord("inflight", orphanRec); err != nil {
		t.Fatal(err)
	}
	staleTime := time.UnixMilli(nowMs).Add(-10 * time.Second)
	if err := os.Chtimes(filepath.Join(aiHome, "run", "peer", "inflight", orphanRec.ID+".json"), staleTime, staleTime); err != nil {
		t.Fatal(err)
	}

	var sentSessions []string
	summary, err := FlushPending(context.Background(), store, FlushOptions{
		Limit:     5,
		ExpireAge: DefaultExpireAge,
		Now:       nowFn,
		Delivery: DeliveryOptions{
			TmuxPath: "tmux",
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				for _, a := range args {
					if a == "display-message" {
						return "0\n", 0, nil
					}
					if a == "-l" {
						sentSessions = append(sentSessions, args[len(args)-4])
					}
				}
				return "", 0, nil
			},
		},
	})
	if err != nil {
		t.Fatalf("FlushPending() error = %v", err)
	}
	if summary.Delivered != 2 {
		t.Fatalf("expected readyRec + recovered orphan delivered (2), got %+v (sessions=%v)", summary, sentSessions)
	}
	if _, err := os.Stat(filepath.Join(aiHome, "run", "peer", "archive", readyRec.ID+".json")); err != nil {
		t.Fatalf("expected readyRec archived: %v", err)
	}
	archivedOld, err := store.readRecord("archive", oldRec.ID)
	if err != nil || archivedOld.State != "failed" || archivedOld.Error != "expired" {
		t.Fatalf("expected expired record in archive as failed/expired, got %+v err=%v", archivedOld, err)
	}
}

func TestDeliverNativeUDSAndWebuiChat(t *testing.T) {
	t.Parallel()

	tmpSockDir, err := os.MkdirTemp("/tmp", "peer-uds-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpSockDir)
	sockPath := filepath.Join(tmpSockDir, "claude.sock")
	listener, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	var receivedLines []string
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			receivedLines = append(receivedLines, scanner.Text())
			if len(receivedLines) >= 2 {
				return
			}
		}
	}()

	cfgDir := t.TempDir()
	pid := 42424
	sum := sha256.Sum256([]byte(sockPath))
	keyPath := filepath.Join(cfgDir, "sessions", fmt.Sprintf("%d.%s.key", pid, hex.EncodeToString(sum[:])))
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte(`{"peerToken":"0123456789abcdef0123456789abcdef"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	nativeRes := DeliverRecord(context.Background(), Record{
		ID:   "pm-native12345678",
		From: RecordParty{Name: "from-sess", Address: "from-addr"},
		To: RecordParty{
			Channel: "native",
			Address: fmt.Sprintf("%d", pid),
			Delivery: &DeliveryTarget{
				Socket: sockPath,
			},
		},
		Body: "hello native",
	}, DeliveryOptions{
		ClaudeConfigDirs:  []string{cfgDir},
		ProbeProcessAlive: func(p int) bool { return p == pid },
		NativeFlushWait:   10 * time.Millisecond,
	})
	wg.Wait()
	if !nativeRes.OK || nativeRes.Channel != "native" || !strings.HasPrefix(nativeRes.ChannelMessageID, "cc-msg-") {
		t.Fatalf("native DeliverRecord() = %+v", nativeRes)
	}
	if len(receivedLines) != 2 || !strings.Contains(receivedLines[0], `"type":"auth"`) || !strings.Contains(receivedLines[1], `hello native`) {
		t.Fatalf("unexpected UDS frames: %v", receivedLines)
	}

	// webui-chat 降级链路: submit(409) -> queue.add(200)
	var seenTypes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var payload struct {
			Type string `json:"type"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		seenTypes = append(seenTypes, payload.Type)
		if payload.Type == "turn.submit" {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"turn_active"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	chatRes := DeliverRecord(context.Background(), Record{
		ID: "pm-chat12345678",
		To: RecordParty{Channel: "webui-chat", SessionID: "chat-s1"},
		Body: "hello chat",
	}, DeliveryOptions{
		ServerBaseURL: func() string { return srv.URL },
		ManagementKey: func() string { return "secret-key" },
	})
	if !chatRes.OK || !chatRes.Queued || len(seenTypes) != 2 || seenTypes[0] != "turn.submit" || seenTypes[1] != "queue.add" {
		t.Fatalf("webui-chat DeliverRecord() = %+v seenTypes=%v", chatRes, seenTypes)
	}
}

func TestDispatchDaemonNonOverlappingAndConcurrentState(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	store := NewDispatchStore(aiHome, StoreOptions{})
	if _, err := store.CreateMessage(CreateMessageInput{
		To: RecordParty{
			Channel:  "inject",
			Delivery: &DeliveryTarget{CLIName: "codex", RuntimeScope: "gateway", SessionName: "s1"},
		},
		Body: "concurrent check",
	}); err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	var runnerCalls atomic.Int32
	tickCh := make(chan time.Time)

	daemon, err := StartDispatchDaemon(context.Background(), DispatchDaemonOptions{
		AIHomeDir:  aiHome,
		testTickCh: tickCh,
		Delivery: DeliveryOptions{
			TmuxPath: "tmux",
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				if runnerCalls.Add(1) == 1 {
					close(entered)
					<-release
				}
				for _, a := range args {
					if a == "display-message" {
						return "0\n", 0, nil
					}
				}
				return "", 0, nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer daemon.Close()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = daemon.Tick(context.Background())
	}()
	<-entered
	st := daemon.State()
	if !st.Ticking || !st.Running {
		close(release)
		t.Fatalf("expected running & ticking state while in flight, got %+v", st)
	}
	// 并发二次 Tick 必须跳过而不是叠跑
	skipped, err := daemon.Tick(context.Background())
	if err != nil {
		close(release)
		t.Fatalf("concurrent skipped Tick error = %v", err)
	}
	if skipped.Attempted != 0 {
		close(release)
		t.Fatalf("expected skipped tick to return last summary without attempting, got %+v", skipped)
	}
	close(release)
	wg.Wait()

	if stAfter := daemon.State(); stAfter.TickCount != 1 || stAfter.LastSummary.Delivered != 1 {
		t.Fatalf("unexpected post-tick state: %+v", stAfter)
	}
}
