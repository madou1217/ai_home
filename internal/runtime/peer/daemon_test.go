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
			Provider: "claude",
			Name:     "worker-pane",
			Address:  "worker-pane",
			Delivery: &DeliveryTarget{
				CLIName:      "claude",
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
	// 活动判定用 pane 内容指纹，输入框守卫解析同一份 capture-pane 内容：
	// 这里给一个「空输入框」的稳定画面——提示符 + 分隔线 + footer，
	// 首个探测视为“刚活动”，内容不变即判定安静。
	paneFixture := strings.Join([]string{
		"› ",
		"────────",
		"100% context left",
	}, "\n")

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
					if a == "capture-pane" {
						return paneFixture, 0, nil
					}
					// 输入框守卫先读光标行；空输入框的光标在第 0 行。
					if strings.Contains(a, "#{cursor_y}") {
						return "0", 0, nil
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
	// 现行探测先读 pane 内容判定「是否在跑」（capture-pane），而不是 query
	// window_activity（display-message）；同一个 tmux 会话里两者都可能出现，
	// 这里断言的是本实现选用的那一种。
	if len(commands) != 1 || commands[0][3] != "capture-pane" {
		mu.Unlock()
		t.Fatalf("Tick 1 expected single capture-pane probe, got %v", commands)
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
	// 命令序列随输入框守卫/内容指纹探测增加，断言「找到了带 envelope 的原文投递」
	// 而不是固定下标；顺序语义（先 probe 后 send-keys）由下面的下标比较保证。
	// 信封已按 eae79515 收敛为紧凑格式：只保留短 id 与来源，不再附带 reply 提示。
	textIndex := -1
	for index, args := range commands {
		if len(args) == 0 {
			continue
		}
		last := args[len(args)-1]
		// 信封前缀带的是短 id（ShortMessageID），与完整文件名不同，这里按结构断言。
		if strings.HasPrefix(last, "[aih-peer #") &&
			strings.Contains(last, " from sender-pane]") &&
			strings.Contains(last, "line1") {
			textIndex = index
			break
		}
	}
	if textIndex < 0 {
		t.Fatalf("未找到带 envelope 的原文投递命令: %v", commands)
	}
	if textIndex == 0 {
		t.Fatalf("原文投递必须发生在探测之后: %v", commands)
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
			// 投递记录要求可验证的发件人身份，缺 From 会被判 peer_record_invalid。
			From: RecordParty{Channel: "inject", Name: "sender", Address: "sender"},
			To: RecordParty{
				Channel: "inject",
				// 每条退避消息指向独立目标：目标级门禁（单点探测）会按目标串行化，
				// 共用 s1 会让第 2 条起直接判忙，测不出「limit 前的就绪过滤」。
				Delivery: &DeliveryTarget{CLIName: "claude", RuntimeScope: "gateway", SessionName: fmt.Sprintf("s%d", i+1)},
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
		ID:   "pm-00000000000000000000000000000099",
		From: RecordParty{Channel: "inject", Name: "sender", Address: "sender"},
		To: RecordParty{
			Channel:  "inject",
			Delivery: &DeliveryTarget{CLIName: "claude", RuntimeScope: "gateway", SessionName: "s6"},
		},
		Body: "ready-now",
	})
	if err != nil {
		t.Fatal(err)
	}

	// 一条已过期消息：走真实创建路径，才能带上自动投递时限等内部字段。
	oldRec, err := store.CreateMessage(CreateMessageInput{
		ID:        "pm-00000000000000000000000000000088",
		From:      RecordParty{Channel: "inject", Name: "sender", Address: "sender"},
		To:        RecordParty{Channel: "inject", Delivery: &DeliveryTarget{CLIName: "claude", RuntimeScope: "gateway", SessionName: "old"}},
		Body:      "expired",
		ExpiresAt: nowMs - 1_000,
	})
	if err != nil {
		t.Fatal(err)
	}

	orphanCreated, err := store.CreateMessage(CreateMessageInput{
		ID:   "pm-00000000000000000000000000000077",
		From: RecordParty{Channel: "inject", Name: "sender", Address: "sender"},
		To:   RecordParty{Channel: "inject", Delivery: &DeliveryTarget{CLIName: "claude", RuntimeScope: "gateway", SessionName: "orphan"}},
		Body: "orphan",
	})
	if err != nil {
		t.Fatal(err)
	}
	// 模拟「claim 前进程崩溃」：把它直接搬到 inflight，不带 claim。
	if err := os.Rename(
		filepath.Join(aiHome, "run", "peer", "pending", orphanCreated.ID+".json"),
		filepath.Join(aiHome, "run", "peer", "inflight", orphanCreated.ID+".json"),
	); err != nil {
		t.Fatal(err)
	}
	orphanRec := *orphanCreated
	orphanRec.CreatedAt = nowMs - 10_000
	staleTime := time.UnixMilli(nowMs).Add(-10 * time.Second)
	if err := os.Chtimes(filepath.Join(aiHome, "run", "peer", "inflight", orphanRec.ID+".json"), staleTime, staleTime); err != nil {
		t.Fatal(err)
	}

	waitQuiet := false
	var sentSessions []string
	summary, err := FlushPending(context.Background(), store, FlushOptions{
		Limit:     5,
		ExpireAge: DefaultExpireAge,
		Now:       nowFn,
		Delivery: DeliveryOptions{
			TmuxPath: "tmux",
			// 本用例只验证「limit 之前先按就绪过滤」：不做安静等待，直接投递。
			WaitForQuiet: &waitQuiet,
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				for _, a := range args {
					if a == "capture-pane" {
						return "› \n────────\n100% context left", 0, nil
					}
					if strings.Contains(a, "#{cursor_y}") {
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
	// 没有收件箱：过期消息不再留在 pending 供人工查看，直接归档为终止记录。
	expiredOld, err := store.readRecord("archive", oldRec.ID)
	if err != nil || expiredOld.NotificationState != "expired" || expiredOld.State != "failed" {
		t.Fatalf("expected expired record archived as failed, got %+v err=%v", expiredOld, err)
	}
	if _, statErr := os.Stat(filepath.Join(aiHome, "run", "peer", "pending", oldRec.ID+".json")); !os.IsNotExist(statErr) {
		t.Fatalf("expired record must leave pending, stat err=%v", statErr)
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
	// 有界等待：投递失败时这里必须报出 nativeRes 的失败原因，而不是让整个包
	// 挂在 wg.Wait() 上直到 go test 超时（会让 go test ./... 停摆十分钟）。
	received := make(chan struct{})
	go func() {
		defer close(received)
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

	// 手工构造的记录必须带 CreatedAt：投递前会投影通知状态，缺少创建时间会让
	// 自动投递时限被判为「已过期」（auto_horizon_elapsed），记录永远不可投。
	nativeRes := DeliverRecord(context.Background(), Record{
		ID:        "pm-native12345678",
		CreatedAt: time.Now().UnixMilli(),
		From:      RecordParty{Name: "from-sess", Address: "from-addr"},
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
	select {
	case <-received:
	case <-time.After(5 * time.Second):
		t.Fatalf("UDS 在 5s 内没有收到两帧（native 投递结果 = %+v）", nativeRes)
	}
	if !nativeRes.OK || nativeRes.Channel != "native" || !strings.HasPrefix(nativeRes.ChannelMessageID, "cc-msg-") {
		t.Fatalf("native DeliverRecord() = %+v", nativeRes)
	}
	if len(receivedLines) != 2 || !strings.Contains(receivedLines[0], `"type":"auth"`) || !strings.Contains(receivedLines[1], `hello native`) {
		t.Fatalf("unexpected UDS frames: %v", receivedLines)
	}

	// webui-chat 忙时的合同：Go 侧把 409 归类为可重试的门禁状态
	// （chat_target_busy，见 target_gate/scheduling_policy），由调度按退避重试，
	// 不再像 Node 适配器那样立刻改发 queue.add。这条测试跟随 Go 的现行合同。
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
		ID:        "pm-chat12345678",
		CreatedAt: time.Now().UnixMilli(),
		To:        RecordParty{Channel: "webui-chat", SessionID: "chat-s1"},
		Body:      "hello chat",
	}, DeliveryOptions{
		ServerBaseURL: func() string { return srv.URL },
		ManagementKey: func() string { return "secret-key" },
	})
	if chatRes.OK || chatRes.Queued || chatRes.Error != "chat_target_busy" || len(seenTypes) != 1 || seenTypes[0] != "turn.submit" {
		t.Fatalf("webui-chat DeliverRecord() = %+v seenTypes=%v", chatRes, seenTypes)
	}
}

func TestDispatchDaemonNonOverlappingAndConcurrentState(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	store := NewDispatchStore(aiHome, StoreOptions{})
	if _, err := store.CreateMessage(CreateMessageInput{
		From: RecordParty{Channel: "inject", Name: "sender", Address: "sender"},
		To: RecordParty{
			Channel:  "inject",
			Delivery: &DeliveryTarget{CLIName: "claude", RuntimeScope: "gateway", SessionName: "s1"},
		},
		Body: "concurrent check",
	}); err != nil {
		t.Fatal(err)
	}

	waitQuiet := false
	entered := make(chan struct{})
	release := make(chan struct{})
	var runnerCalls atomic.Int32
	tickCh := make(chan time.Time)

	daemon, err := StartDispatchDaemon(context.Background(), DispatchDaemonOptions{
		AIHomeDir:  aiHome,
		testTickCh: tickCh,
		Delivery: DeliveryOptions{
			TmuxPath: "tmux",
			// 本用例验证「Tick 不重叠」，不涉及安静等待与注入协议。
			WaitForQuiet: &waitQuiet,
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				if runnerCalls.Add(1) == 1 {
					close(entered)
					<-release
				}
				for _, a := range args {
					if a == "capture-pane" {
						return "› \n────────\n100% context left", 0, nil
					}
					if strings.Contains(a, "#{cursor_y}") {
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
