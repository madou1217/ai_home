package chatruntime

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

type stubAccountPool struct {
	models accountapp.AccountModelCatalog
}

func (s *stubAccountPool) ListAllAccountModels(_ context.Context) (accountapp.AccountModelCatalog, error) {
	return s.models, nil
}

func (s *stubAccountPool) ListAccountOverviews(_ context.Context, _ accountapp.OverviewQuery) ([]accountapp.AccountOverview, error) {
	return nil, nil
}

func openTestServiceStore(t *testing.T) (*Store, *PublishingStore, *EventHub) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	store, err := OpenStoreWithOptions(context.Background(), StoreOptions{
		DBPath: dbPath,
	})
	if err != nil {
		t.Fatalf("OpenStoreWithOptions failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	hub := NewEventHub()
	pub := NewPublishingStore(PublishingStoreOptions{
		Store:    store,
		EventHub: hub,
	})
	return store, pub, hub
}

func TestAttachmentServiceUploadAndValidation(t *testing.T) {
	ctx := context.Background()
	_, pub, _ := openTestServiceStore(t)
	tmp := t.TempDir()

	if _, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-att",
		Provider:            "claude",
		ExecutionAccountRef: "acct-1",
	}); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	svc, err := NewAttachmentService(AttachmentServiceOptions{
		Store:       pub,
		AIHomeDir:   filepath.Join(tmp, ".ai_home"),
		HostHomeDir: tmp,
		TempRootDir: filepath.Join(tmp, "tmp-att"),
	})
	if err != nil {
		t.Fatalf("NewAttachmentService: %v", err)
	}

	pngBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02}
	imgURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
	docURL := "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte("hello attachment\nline 2"))

	uploaded, err := svc.Upload(ctx, "sess-att", []AttachmentUploadInput{
		{Name: "shot.png", MimeType: "image/png", DataURL: imgURL},
		{Name: "notes.txt", MimeType: "text/plain", DataURL: docURL},
	})
	if err != nil {
		t.Fatalf("Upload failed: %v", err)
	}
	if len(uploaded) != 2 {
		t.Fatalf("expected 2 attachments, got %d", len(uploaded))
	}
	for _, a := range uploaded {
		if _, err := os.Stat(a.FilePath); err != nil {
			t.Fatalf("attachment file missing %s: %v", a.FilePath, err)
		}
	}

	if _, err := svc.Upload(ctx, "missing-sess", []AttachmentUploadInput{
		{Name: "shot.png", MimeType: "image/png", DataURL: imgURL},
	}); err == nil {
		t.Fatalf("expected error for missing session")
	}

	if _, err := svc.Upload(ctx, "sess-att", []AttachmentUploadInput{
		{Name: "bad.exe", MimeType: "application/x-msdownload", DataURL: docURL},
	}); err == nil {
		t.Fatalf("expected error for unsupported extension/mime")
	}

	tooMany := make([]AttachmentUploadInput, MaxAttachmentFiles+1)
	for i := range tooMany {
		tooMany[i] = AttachmentUploadInput{Name: "notes.txt", MimeType: "text/plain", DataURL: docURL}
	}
	if _, err := svc.Upload(ctx, "sess-att", tooMany); err == nil {
		t.Fatalf("expected error for > MaxAttachmentFiles")
	}
}

func TestWorkspaceCheckpointsRealGitRepo(t *testing.T) {
	ctx := context.Background()
	repo := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
		}
	}
	runGit("init")
	runGit("config", "user.name", "Tester")
	runGit("config", "user.email", "tester@example.com")

	tracked := filepath.Join(repo, "main.txt")
	if err := os.WriteFile(tracked, []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit("add", "main.txt")
	runGit("commit", "-m", "init")

	// Modify tracked file + create untracked file before turn checkpoint.
	if err := os.WriteFile(tracked, []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(repo, "note.txt")
	if err := os.WriteFile(extra, []byte("note-v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	opener := DefaultWorkspaceCheckpointsOpener(t.TempDir(), repo, nil)
	cp, err := opener(ctx, repo)
	if err != nil || cp == nil {
		t.Fatalf("DefaultWorkspaceCheckpointsOpener failed: cp=%v err=%v", cp, err)
	}
	snap, err := cp.Snapshot(ctx, "sess-cp-1", "turn_1")
	if err != nil {
		t.Fatalf("Snapshot failed: %v", err)
	}
	if snap.Commit == "" {
		t.Fatalf("expected non-empty checkpoint commit, got %+v", snap)
	}

	// Mutate workspace again.
	if err := os.WriteFile(tracked, []byte("v3-dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	later := filepath.Join(repo, "later.txt")
	if err := os.WriteFile(later, []byte("later\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	listed, err := cp.List(ctx, "sess-cp-1")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(listed.Checkpoints) == 0 || listed.Checkpoints[0].Commit != snap.Commit {
		t.Fatalf("unexpected checkpoints list: %+v", listed)
	}

	changes, err := cp.Changes(ctx, snap.Commit)
	if err != nil {
		t.Fatalf("Changes failed: %v", err)
	}
	if len(changes.Files) == 0 {
		t.Fatalf("expected changed files between workspace and %s", snap.Commit)
	}

	restored, err := cp.Restore(ctx, "sess-cp-1", snap.Commit)
	if err != nil {
		t.Fatalf("Restore failed: %v", err)
	}
	if restored.Restored != snap.Commit {
		t.Fatalf("unexpected restore result: %+v", restored)
	}
	gotTracked, err := os.ReadFile(tracked)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotTracked) != "v2\n" {
		t.Fatalf("expected main.txt reverted to v2, got %q", string(gotTracked))
	}
	if _, err := os.Stat(later); !os.IsNotExist(err) {
		t.Fatalf("expected later.txt removed on restore, err=%v", err)
	}
}

func TestDocumentBudgetAndCommandCatalog(t *testing.T) {
	ctx := context.Background()
	hugeDoc := strings.Repeat("alpha beta gamma delta\n", 400)
	report := ApplyDocumentTokenBudget("user prompt", []string{hugeDoc}, "", 2000, 10)
	if report.TruncatedBlocks == 0 || len(report.DocumentBlocks) != 1 {
		t.Fatalf("expected truncated document report, got %+v", report)
	}

	cat := NewCapabilityCommandCatalog()
	sess := &Session{
		SessionID: "sess-cat",
		Provider:  "codex",
		CapabilitySnapshot: map[string]any{
			"capabilities": map[string]any{
				"turn.interrupt": map[string]any{"support": "native"},
				"turn.queue":     map[string]any{"support": "emulated"},
			},
			"slashCommands":      []string{"compact", "plan"},
			"turnInterveneModes": []string{"steer_current"},
		},
	}
	entries := cat.List(ctx, sess, true)
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.Type] = true
	}
	for _, want := range []string{"turn.submit", "turn.interrupt", "session.fork", "turn.regenerate", "turn.intervene", "queue.add", "slash.execute"} {
		if !seen[want] {
			t.Fatalf("expected command %q in catalog, got %+v", want, entries)
		}
	}

	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	am, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        ref,
		ModelID:           "gpt-4o",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(1700000000000),
	})
	if err != nil {
		t.Fatal(err)
	}
	provCat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	resolver := &ModelCatalogResolver{
		AIHomeDir: t.TempDir(),
		Catalog:   provCat,
		AccountStore: &stubAccountPool{
			models: accountapp.AccountModelCatalog{
				Sets: []accountapp.AccountModelSet{{
					AccountRef: ref,
					ProviderID: "opencode",
					Models:     []accountapp.AccountModel{am},
				}},
			},
		},
	}
	chatSess := &Session{SessionID: "sess-route", Provider: "codex", Policy: map[string]any{}}
	route := resolver.ResolveChatTurnRoute(ctx, chatSess, map[string]any{"model": "gpt-4o"}, nil)
	if route.Target != RouteTargetGo {
		t.Fatalf("expected RouteTargetGo for gpt-4o gateway model, got %+v", route)
	}
}

func TestGoChatDriverTurnStreamAndInterrupt(t *testing.T) {
	ctx := context.Background()
	_, pub, _ := openTestServiceStore(t)
	sess, err := pub.CreateSession(ctx, CreateSessionInput{
		SessionID:           "sess-gochat",
		Provider:            "codex",
		ExecutionAccountRef: GatewayRuntimeScope,
	})
	if err != nil {
		t.Fatal(err)
	}

	streamer := ChatTurnStreamerFunc(func(ctx context.Context, req ChatTurnStreamRequest, emit func(ChatTurnStreamEvent) error) error {
		if req.Model != "gpt-4o" {
			return fmt.Errorf("unexpected model: %s", req.Model)
		}
		if len(req.Messages) < 2 {
			return fmt.Errorf("expected system+user messages")
		}
		if err := emit(ChatTurnStreamEvent{Type: "timeline.item.started", ItemID: "msg-1"}); err != nil {
			return err
		}
		if err := emit(ChatTurnStreamEvent{Type: "timeline.item.delta", ItemID: "msg-1", Chunk: "Hello "}); err != nil {
			return err
		}
		if err := emit(ChatTurnStreamEvent{Type: "timeline.item.delta", ItemID: "msg-1", Chunk: "Go!"}); err != nil {
			return err
		}
		if err := emit(ChatTurnStreamEvent{
			Type:    "timeline.item.completed",
			ItemID:  "msg-1",
			Content: "Hello Go!",
			Metrics: map[string]any{"durationMs": int64(25)},
		}); err != nil {
			return err
		}
		return emit(ChatTurnStreamEvent{Type: "turn.completed"})
	})

	drv, err := NewGoChatDriver(GoChatDriverOptions{
		Session:  sess,
		Store:    pub,
		Streamer: streamer,
	})
	if err != nil {
		t.Fatalf("NewGoChatDriver: %v", err)
	}
	defer drv.Dispose()

	_, err = pub.BeginTurn(ctx, sess.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "turn-1", RunID: "run-1", StartedAt: time.Now().UnixMilli(), State: "running"},
		Event:      EventDraft{Type: "turn.started", TurnID: "turn-1", RunID: "run-1", Source: EventSource{Provider: "codex", RuntimeID: GatewayRuntimeScope}},
	})
	if err != nil {
		t.Fatal(err)
	}

	run, err := drv.StartTurn(ctx, DriverTurnContext{
		SessionID: sess.SessionID,
		TurnID:    "turn-1",
		RunID:     "run-1",
		Command: &Command{
			CommandID: "cmd-1",
			SessionID: sess.SessionID,
			Type:      "turn.submit",
			Payload:   map[string]any{"content": "hi", "model": "gpt-4o"},
		},
	})
	if err != nil {
		t.Fatalf("StartTurn failed: %v", err)
	}
	res := <-run.Done
	if res.Err != nil {
		t.Fatalf("GoChat run failed: %v", res.Err)
	}
	page, err := pub.ReadTimeline(ctx, sess.SessionID, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	var foundAssistant string
	for _, it := range page.Items {
		if asString(it.Detail["role"]) == "assistant" {
			if it.Content != nil {
				foundAssistant = *it.Content
			}
		}
	}
	if foundAssistant != "Hello Go!" {
		t.Fatalf("expected assistant content 'Hello Go!', got %q (items=%+v)", foundAssistant, page.Items)
	}

	// Test interrupt cancels active stream cleanly.
	_, err = pub.BeginTurn(ctx, sess.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "turn-2", RunID: "run-2", StartedAt: time.Now().UnixMilli(), State: "running"},
		Event:      EventDraft{Type: "turn.started", TurnID: "turn-2", RunID: "run-2", Source: EventSource{Provider: "codex", RuntimeID: GatewayRuntimeScope}},
	})
	if err != nil {
		t.Fatal(err)
	}
	startedBlock := make(chan struct{})
	blockStreamer := ChatTurnStreamerFunc(func(ctx context.Context, _ ChatTurnStreamRequest, _ func(ChatTurnStreamEvent) error) error {
		close(startedBlock)
		<-ctx.Done()
		return ctx.Err()
	})
	drv2, err := NewGoChatDriver(GoChatDriverOptions{
		Session:  sess,
		Store:    pub,
		Streamer: blockStreamer,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer drv2.Dispose()

	run2, err := drv2.StartTurn(ctx, DriverTurnContext{
		SessionID: sess.SessionID,
		TurnID:    "turn-2",
		RunID:     "run-2",
		Command: &Command{
			CommandID: "cmd-2",
			SessionID: sess.SessionID,
			Type:      "turn.submit",
			Payload:   map[string]any{"content": "wait", "model": "gpt-4o"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	<-startedBlock
	if err := drv2.InterruptTurn(ctx, DriverTurnContext{TurnID: "turn-2", RunID: "run-2"}); err != nil {
		t.Fatalf("InterruptTurn failed: %v", err)
	}
	res2 := <-run2.Done
	if res2.Err != nil || asString(res2.Result["status"]) != "interrupted" {
		t.Fatalf("expected interrupted result, got %+v", res2)
	}
}

// TestHelperCodexRPCProcess 作为真实子进程桩被 TestCodexAppServerClientStdioHelper 拉起。
func TestHelperCodexRPCProcess(t *testing.T) {
	if os.Getenv("GO_WANT_CODEX_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg CodexJSONRPCMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msg.ID == nil {
			continue
		}
		var result map[string]any
		switch msg.Method {
		case "initialize":
			result = map[string]any{"serverInfo": map[string]any{"name": "fake-codex"}}
		case "account/read":
			result = map[string]any{"account": map[string]any{"email": "helper@example.com"}}
		case "thread/start":
			result = map[string]any{"thread": map[string]any{"id": "thr-stdio-1"}}
		default:
			result = map[string]any{}
		}
		resp := map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result}
		raw, _ := json.Marshal(resp)
		fmt.Println(string(raw))
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "helper scanner err: %v\n", err)
	}
}

func TestCodexAppServerClientStdioHelper(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := NewCodexAppServerClient(CodexAppServerClientOptions{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		AccountRef:  "acct-stdio",
		Command:     os.Args[0],
		Args:        []string{"-test.run=^TestHelperCodexRPCProcess$"},
		Env:         append(os.Environ(), "GO_WANT_CODEX_HELPER=1"),
	})
	defer func() { _ = client.Close() }()

	if err := client.EnsureConnected(ctx); err != nil {
		client.mu.Lock()
		st := client.stderrTail.String()
		client.mu.Unlock()
		t.Fatalf("EnsureConnected failed: %v (stderr=%q)", err, st)
	}
	res, err := client.Request(ctx, "thread/start", map[string]any{"cwd": "/tmp"})
	if err != nil {
		t.Fatalf("thread/start failed: %v", err)
	}
	thr, _ := res["thread"].(map[string]any)
	if asString(thr["id"]) != "thr-stdio-1" {
		t.Fatalf("unexpected thread response: %+v", res)
	}
}

type fakeCodexRPCClient struct {
	mu        sync.Mutex
	bindings  map[string]CodexTurnBinding
	requests  []string
	respOut   chan map[string]any
	closeCh   chan struct{}
	closeOnce sync.Once
}

func newFakeCodexRPCClient() *fakeCodexRPCClient {
	return &fakeCodexRPCClient{
		bindings: map[string]CodexTurnBinding{},
		respOut:  make(chan map[string]any, 4),
		closeCh:  make(chan struct{}),
	}
}

func (f *fakeCodexRPCClient) EnsureConnected(_ context.Context) error { return nil }
func (f *fakeCodexRPCClient) Close() error                            { f.closeOnce.Do(func() { close(f.closeCh) }); return nil }
func (f *fakeCodexRPCClient) ReleaseThread(_ context.Context, _ string) error {
	return nil
}
func (f *fakeCodexRPCClient) GetVerifiedAccountIdentity() *CodexVerifiedIdentity {
	return &CodexVerifiedIdentity{Verified: true, Kind: "oauth", Assurance: "runtime-home", AccountRef: "acct-1"}
}
func (f *fakeCodexRPCClient) GetVerifiedRuntimeHome() (CodexRuntimeHome, bool) {
	return CodexRuntimeHome{RuntimeScope: "acct-1"}, true
}
func (f *fakeCodexRPCClient) BindTurn(threadID string, binding CodexTurnBinding) {
	f.mu.Lock()
	f.bindings[threadID] = binding
	f.mu.Unlock()
}
func (f *fakeCodexRPCClient) UnbindTurn(threadID string) {
	f.mu.Lock()
	delete(f.bindings, threadID)
	f.mu.Unlock()
}
func (f *fakeCodexRPCClient) Respond(_ context.Context, _ any, result any) error {
	m, _ := result.(map[string]any)
	f.respOut <- m
	return nil
}
func (f *fakeCodexRPCClient) RespondError(_ context.Context, _ any, _ int, _ string) error {
	return nil
}
func (f *fakeCodexRPCClient) Request(_ context.Context, method string, params any) (map[string]any, error) {
	f.mu.Lock()
	f.requests = append(f.requests, method)
	b := f.bindings["thr-fake-1"]
	f.mu.Unlock()

	switch method {
	case "account/read":
		return map[string]any{"account": map[string]any{"email": "fake@example.com"}}, nil
	case "model/list":
		return map[string]any{"data": []any{map[string]any{"model": "gpt-5-codex", "displayName": "GPT-5 Codex", "isDefault": true, "defaultReasoningEffort": "medium", "supportedReasoningEfforts": []any{map[string]any{"reasoningEffort": "medium"}, map[string]any{"reasoningEffort": "high"}}}}}, nil
	case "thread/start":
		return map[string]any{"thread": map[string]any{"id": "thr-fake-1"}}, nil
	case "thread/resume":
		return map[string]any{"thread": map[string]any{"id": "thr-fake-1", "turns": []any{}}}, nil
	case "turn/start":
		p, _ := params.(map[string]any)
		_ = p
		go func() {
			if b.OnNotification != nil {
				b.OnNotification(CodexJSONRPCMessage{
					Method: "turn/started",
					Params: map[string]any{"threadId": "thr-fake-1", "turn": map[string]any{"id": "nturn-1"}},
				})
			}
			if b.OnServerRequest != nil {
				b.OnServerRequest(CodexJSONRPCMessage{
					ID:     "srv-1",
					Method: "item/commandExecution/requestApproval",
					Params: map[string]any{
						"threadId":           "thr-fake-1",
						"turnId":             "nturn-1",
						"itemId":             "cmd-item-1",
						"command":            "echo hello",
						"availableDecisions": []any{"accept", "decline"},
					},
				})
			}
			select {
			case <-f.respOut:
			case <-f.closeCh:
				return
			}
			if b.OnNotification != nil {
				b.OnNotification(CodexJSONRPCMessage{
					Method: "item/started",
					Params: map[string]any{
						"threadId": "thr-fake-1",
						"turnId":   "nturn-1",
						"item": map[string]any{
							"id":   "amsg-1",
							"type": "agentMessage",
							"text": "",
						},
					},
				})
				b.OnNotification(CodexJSONRPCMessage{
					Method: "item/agentMessage/delta",
					Params: map[string]any{
						"threadId": "thr-fake-1",
						"turnId":   "nturn-1",
						"itemId":   "amsg-1",
						"delta":    "Approved result",
					},
				})
				b.OnNotification(CodexJSONRPCMessage{
					Method: "item/completed",
					Params: map[string]any{
						"threadId": "thr-fake-1",
						"turnId":   "nturn-1",
						"item": map[string]any{
							"id":   "amsg-1",
							"type": "agentMessage",
							"text": "Approved result",
						},
					},
				})
				b.OnNotification(CodexJSONRPCMessage{
					Method: "turn/completed",
					Params: map[string]any{
						"threadId": "thr-fake-1",
						"turn":     map[string]any{"id": "nturn-1", "status": "completed"},
					},
				})
			}
		}()
		return map[string]any{"turn": map[string]any{"id": "nturn-1"}}, nil
	default:
		return map[string]any{}, nil
	}
}

func TestCodexSessionDriverTurnApprovalAndRecovery(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	fakeRPC := newFakeCodexRPCClient()

	tmp := t.TempDir()
	codexRef, _ := accountcore.ParseAccountRef("acct_11111111111111111111")
	codexMod, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        codexRef,
		ModelID:           "gpt-5-codex",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(1700000000000),
	})
	svc, err := NewService(ctx, ServiceOptions{
		DBPath:         filepath.Join(tmp, "app-state.db"),
		AIHomeDir:      filepath.Join(tmp, ".ai_home"),
		HostHomeDir:    tmp,
		CodexRPCClient: fakeRPC,
		AccountStore: &stubAccountPool{models: accountapp.AccountModelCatalog{
			Sets: []accountapp.AccountModelSet{{AccountRef: codexRef, ProviderID: "codex", Models: []accountapp.AccountModel{codexMod}}},
		}},
		IsModelEnabled: func(string) bool { return true },
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer func() { _ = svc.Close() }()

	sess, err := svc.CreateSession(ctx, CreateSessionInput{
		Provider:            "codex",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         tmp,
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	eventsCh := make(chan EventEnvelope, 32)
	unsub, err := svc.Subscribe(sess.SessionID, func(ev EventEnvelope) {
		eventsCh <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	if _, err := svc.DispatchCommand(ctx, sess.SessionID, map[string]any{
		"commandId": "cmd-codex-1",
		"type":      "turn.submit",
		"payload": map[string]any{
			"content":      "run echo",
			"model":        "gpt-5-codex",
			"approvalMode": "suggest",
		},
	}); err != nil {
		t.Fatalf("DispatchCommand turn.submit: %v", err)
	}

	var interactionID string
	deadline := time.After(5 * time.Second)
	for interactionID == "" {
		select {
		case ev := <-eventsCh:
			if ev.Type == "interaction.requested" {
				inter := asMap(ev.Payload["interaction"])
				interactionID = asString(inter["interactionId"])
			} else if ev.Type == "stream.error" || ev.Type == "turn.failed" {
				t.Fatalf("unexpected failure event: %s %+v", ev.Type, ev.Payload)
			}
		case <-deadline:
			t.Fatalf("timed out waiting for interaction.requested")
		}
	}

	if _, err := svc.DispatchCommand(ctx, sess.SessionID, map[string]any{
		"commandId": "cmd-codex-approve",
		"type":      "approval.decide",
		"payload": map[string]any{
			"interactionId": interactionID,
			"revision":      1,
			"choiceId":      "choice-0",
		},
	}); err != nil {
		t.Fatalf("DispatchCommand approval.decide: %v", err)
	}

	if err := svc.WaitForActorIdle(ctx, sess.SessionID); err != nil {
		t.Fatalf("WaitForActorIdle: %v", err)
	}

	snap, err := svc.GetSnapshot(ctx, sess.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.State != "idle" {
		t.Fatalf("expected session idle after turn completion, got %s", snap.State)
	}
	tl, err := svc.ReadTimeline(ctx, sess.SessionID, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	var gotReply string
	for _, it := range tl.Items {
		if asString(it.Detail["role"]) == "assistant" {
			if it.Content != nil {
				gotReply = *it.Content
			}
		}
	}
	if gotReply != "Approved result" {
		t.Fatalf("expected 'Approved result', got %q", gotReply)
	}
}

type fakeNativeRunner struct {
	mu       sync.Mutex
	attempts []string
	steered  []string
}

func (r *fakeNativeRunner) Start(_ context.Context, req NativeRunRequest) (*NativeRunHandle, error) {
	r.mu.Lock()
	r.attempts = append(r.attempts, req.AccountRef)
	attemptNum := len(r.attempts)
	r.mu.Unlock()

	events := make(chan NativeRunEvent, 4)
	sids := make(chan string, 1)
	done := make(chan NativeRunExit, 1)

	go func() {
		if attemptNum == 1 {
			done <- NativeRunExit{ExitCode: 1, Stderr: "429 rate limit exceeded capacity"}
			close(events)
			close(sids)
			close(done)
			return
		}
		sids <- "native-claude-sess-1"
		events <- NativeRunEvent{Type: "delta", Delta: "Recovered native answer"}
		done <- NativeRunExit{ExitCode: 0, SessionID: "native-claude-sess-1"}
		close(events)
		close(sids)
		close(done)
	}()

	return &NativeRunHandle{
		RunID: req.RunID,
		WriteSteer: func(content string) error {
			r.mu.Lock()
			r.steered = append(r.steered, content)
			r.mu.Unlock()
			return nil
		},
		Abort:      func() error { return nil },
		Events:     events,
		SessionIDs: sids,
		Done:       done,
	}, nil
}

func TestNativeSessionDriverParseStreamFallbackAndHistory(t *testing.T) {
	ctx := context.Background()
	st := &NativeStreamState{}
	chunks := ParseNativeStreamLine("claude", `{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there"}]}}`, st)
	if len(chunks) == 0 || chunks[0].Delta != "Hi there" {
		t.Fatalf("unexpected claude parse chunks: %+v", chunks)
	}

	gChunks := ParseNativeStreamLine("gemini", `{"type":"message","role":"assistant","content":"Gemini hello","delta":true}`, &NativeStreamState{})
	if len(gChunks) == 0 || gChunks[0].Delta != "Gemini hello" {
		t.Fatalf("unexpected gemini parse chunks: %+v", gChunks)
	}

	res := ResolveNativeApprovalTransport("claude", "confirm", map[string]bool{spawnerNativeStream: true})
	if res.Support != "native" {
		t.Fatalf("expected native approval support for claude suggest, got %+v", res)
	}

	tmp := t.TempDir()
	runner := &fakeNativeRunner{}
	svc, err := NewService(ctx, ServiceOptions{
		DBPath:       filepath.Join(tmp, "app-state.db"),
		AIHomeDir:    filepath.Join(tmp, ".ai_home"),
		HostHomeDir:  tmp,
		NativeRunner: runner,
		ResolveFallbackAccounts: func(_ context.Context, _ string, currentRef string) []string {
			if currentRef == "acct-primary" {
				return []string{"acct-fallback"}
			}
			return nil
		},
		ResolveDefaultModel: func(_ string) string { return "claude-sonnet-4-5" },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = svc.Close() }()

	sess, err := svc.CreateSession(ctx, CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-primary",
		ProjectPath:         tmp,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.DispatchCommand(ctx, sess.SessionID, map[string]any{
		"commandId": "cmd-nat-1",
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "test retry"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.WaitForActorIdle(ctx, sess.SessionID); err != nil {
		t.Fatal(err)
	}

	runner.mu.Lock()
	attempts := append([]string(nil), runner.attempts...)
	runner.mu.Unlock()
	if len(attempts) != 2 || attempts[0] != "acct-primary" || attempts[1] != "acct-fallback" {
		t.Fatalf("expected retry from acct-primary to acct-fallback, got %+v", attempts)
	}

	tl, err := svc.ReadTimeline(ctx, sess.SessionID, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	var text string
	for _, it := range tl.Items {
		if asString(it.Detail["role"]) == "assistant" {
			if it.Content != nil {
				text = *it.Content
			}
		}
	}
	if text != "Recovered native answer" {
		t.Fatalf("expected 'Recovered native answer', got %q", text)
	}
}

func TestCapabilityRoutedChatDriverRouting(t *testing.T) {
	ctx := context.Background()
	_, pub, _ := openTestServiceStore(t)

	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	am, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        ref,
		ModelID:           "gpt-4o",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(1700000000000),
	})
	provCat, _ := providers.NewCatalog(providers.BuiltinManifest())
	resolver := &ModelCatalogResolver{
		AIHomeDir: t.TempDir(),
		Catalog:   provCat,
		AccountStore: &stubAccountPool{
			models: accountapp.AccountModelCatalog{
				Sets: []accountapp.AccountModelSet{{
					AccountRef: ref,
					ProviderID: "opencode",
					Models:     []accountapp.AccountModel{am},
				}},
			},
		},
	}

	sess := &Session{
		SessionID:           "sess-routed",
		Provider:            "codex",
		ExecutionAccountRef: GatewayRuntimeScope,
		Policy:              map[string]any{"model": "gpt-4o"},
	}
	canonicalCaps := CodexCapabilities(RuntimeDescriptor{Provider: "codex"})
	entry, err := CreateCapabilityRoutedChatDriverEntry(CapabilityRoutedDriverOptions{
		Session:       sess,
		Store:         pub,
		Catalog:       resolver,
		CanonicalCaps: canonicalCaps,
		CreateGoEntry: func(_ context.Context) (*DriverEntry, error) {
			return CreateGoChatDriverEntry(GoChatDriverOptions{
				Session:  sess,
				Store:    pub,
				Streamer: ChatTurnStreamerFunc(func(context.Context, ChatTurnStreamRequest, func(ChatTurnStreamEvent) error) error { return nil }),
			})
		},
		CreateNodeEntry: func(_ context.Context) (*DriverEntry, error) {
			return &DriverEntry{Capabilities: canonicalCaps}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	goCaps := entry.CapabilitiesFor(sess)
	if asString(goCaps["revision"]) != "go-chat-relay-v1" {
		t.Fatalf("expected go-chat-relay-v1 capabilities, got %+v", goCaps)
	}

	sessNonGo := *sess
	sessNonGo.Policy = map[string]any{"model": "codex-unknown-only"}
	fallbackCaps := entry.CapabilitiesFor(&sessNonGo)
	if asString(fallbackCaps["revision"]) == "go-chat-relay-v1" {
		t.Fatalf("expected canonical caps when model is not Go-routable, got %+v", fallbackCaps)
	}
	_ = ctx
}

func TestServiceEndToEndLifecycleCheckpointsEventsAndBranching(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tmp := t.TempDir()
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	am, _ := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        ref,
		ModelID:           "gpt-4o",
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(1700000000000),
	})

	svc, err := NewService(ctx, ServiceOptions{
		DBPath:              filepath.Join(tmp, "app-state.db"),
		AIHomeDir:           filepath.Join(tmp, ".ai_home"),
		HostHomeDir:         tmp,
		AccountStore:        &stubAccountPool{models: accountapp.AccountModelCatalog{Sets: []accountapp.AccountModelSet{{AccountRef: ref, ProviderID: "opencode", Models: []accountapp.AccountModel{am}}}}},
		EventRetentionLimit: 2,
		ChatStreamer: ChatTurnStreamerFunc(func(_ context.Context, _ ChatTurnStreamRequest, emit func(ChatTurnStreamEvent) error) error {
			if err := emit(ChatTurnStreamEvent{Type: "timeline.item.started", ItemID: "msg-a"}); err != nil {
				return err
			}
			if err := emit(ChatTurnStreamEvent{Type: "timeline.item.delta", ItemID: "msg-a", Chunk: "Chat reply"}); err != nil {
				return err
			}
			if err := emit(ChatTurnStreamEvent{Type: "timeline.item.completed", ItemID: "msg-a", Content: "Chat reply"}); err != nil {
				return err
			}
			return emit(ChatTurnStreamEvent{Type: "turn.completed"})
		}),
		ArtifactReader: ArtifactReaderFunc(func(_ context.Context, artifactID string) (*Artifact, error) {
			if artifactID == "art-1" {
				return &Artifact{ContentType: "text/plain", Body: []byte("artifact body")}, nil
			}
			return nil, nil
		}),
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer func() { _ = svc.Close() }()

	// OpenChatSession + turn + ReadComposerCatalog + ReadEvents gap
	chatSess, err := svc.OpenChatSession(ctx, OpenChatSessionInput{Provider: "codex"})
	if err != nil {
		t.Fatalf("OpenChatSession: %v", err)
	}
	if _, err := svc.DispatchCommand(ctx, chatSess.SessionID, map[string]any{
		"commandId": "cmd-e2e-turn-1",
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "hello chat", "model": "gpt-4o"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.WaitForActorIdle(ctx, chatSess.SessionID); err != nil {
		t.Fatal(err)
	}

	tl, err := svc.ReadTimeline(ctx, chatSess.SessionID, "", 30)
	if err != nil || len(tl.Items) < 2 {
		t.Fatalf("expected at least 2 timeline items, got err=%v items=%+v", err, tl)
	}

	// Fork from first message
	forkRes, err := svc.DispatchCommand(ctx, chatSess.SessionID, map[string]any{
		"commandId": "cmd-fork-1",
		"type":      "session.fork",
		"payload":   map[string]any{"sourceItemId": tl.Items[0].ID},
	})
	if err != nil {
		t.Fatalf("session.fork failed: %v", err)
	}
	resultMap, _ := forkRes["result"].(map[string]any)
	childSess, _ := resultMap["session"].(*Session)
	if childSess == nil || childSess.SessionID == "" {
		t.Fatalf("expected forked child session, got %+v", forkRes)
	}

	// EventRetentionLimit = 2, so after=0 must trigger Gap=true + Snapshot!
	evRes, err := svc.ReadEvents(ctx, chatSess.SessionID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !evRes.Gap || evRes.Snapshot == nil {
		t.Fatalf("expected Gap=true and Snapshot on evicted cursor 0, got %+v", evRes)
	}

	compCat, err := svc.ReadComposerCatalog(ctx, chatSess.SessionID)
	if err != nil || compCat["defaultModel"] == "" {
		t.Fatalf("unexpected ReadComposerCatalog: cat=%+v err=%v", compCat, err)
	}

	art, err := svc.ReadArtifact(ctx, "art-1")
	if err != nil || art == nil || string(art.Body) != "artifact body" {
		t.Fatalf("unexpected artifact: art=%+v err=%v", art, err)
	}
	missingArt, err := svc.ReadArtifact(ctx, "missing")
	if err != nil || missingArt != nil {
		t.Fatalf("expected nil artifact for missing id, got %+v err=%v", missingArt, err)
	}

	// ResolveSession created -> adopted idempotency
	workProj := t.TempDir()
	res1, err := svc.ResolveSession(ctx, CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         workProj,
		NativeSessionID:     "nat-resolve-1",
	})
	if err != nil || res1.Status != "created" {
		t.Fatalf("expected ResolveSession status=created, got %+v err=%v", res1, err)
	}
	res2, err := svc.ResolveSession(ctx, CreateSessionInput{
		SessionID:           res1.Session.SessionID,
		Provider:            "claude",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         workProj,
		NativeSessionID:     "nat-resolve-1",
	})
	if err != nil || res2.Status != "adopted" {
		t.Fatalf("expected ResolveSession status=adopted, got %+v err=%v", res2, err)
	}

	// Catalog & Delete
	cmds, err := svc.GetCommandCatalog(ctx, chatSess.SessionID)
	if err != nil || len(cmds) == 0 {
		t.Fatalf("GetCommandCatalog failed: %+v err=%v", cmds, err)
	}
	delRes, err := svc.DeleteSession(ctx, childSess.SessionID)
	if err != nil || asString(delRes["sessionId"]) != childSess.SessionID {
		t.Fatalf("DeleteSession failed: %+v err=%v", delRes, err)
	}
}
