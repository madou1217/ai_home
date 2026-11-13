package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	_ "modernc.org/sqlite"
)

func openTestStore(t *testing.T) (*Store, *atomic.Int64) {
	t.Helper()
	var tick atomic.Int64
	tick.Store(1700000000000)
	var seqID atomic.Int64
	dbPath := filepath.Join(t.TempDir(), "app-state.db")
	store, err := OpenStoreWithOptions(context.Background(), StoreOptions{
		DBPath:                  dbPath,
		EnableHistoryCompaction: false,
		Clock: func() int64 {
			return tick.Add(10)
		},
		IDFactory: func(prefix string) string {
			return prefix + "-test-" + string(rune('a'+(seqID.Add(1)%26))) + "-" + itoa(seqID.Load())
		},
	})
	if err != nil {
		t.Fatalf("OpenStore failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, &tick
}

func itoa(v int64) string {
	return string([]byte(func() string {
		if v == 0 {
			return "0"
		}
		var buf [20]byte
		i := len(buf)
		for v > 0 {
			i--
			buf[i] = byte('0' + v%10)
			v /= 10
		}
		return string(buf[i:])
	}()))
}

func TestStoreMigrationsAndSessionLifecycle(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "legacy-app-state.db")

	// Pre-populate legacy credential_ref schema + workspaceMode + legacy agy_message events.
	raw, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=rwc")
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	legacySQL := `
		CREATE TABLE chat_runtime_sessions (
			session_id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			project_path TEXT NOT NULL DEFAULT '',
			state TEXT NOT NULL,
			runtime_binding_json TEXT NOT NULL,
			capability_snapshot_json TEXT NOT NULL,
			policy_json TEXT NOT NULL,
			active_turn_json TEXT,
			last_event_seq INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		INSERT INTO chat_runtime_sessions VALUES
			('s-1', 'codex', 'acct-1', '/tmp/proj', 'idle', '{"nativeSessionId":"nat-1"}', '{}', '{"workspaceMode":"work","model":"gpt-5"}', NULL, 0, 100, 100),
			('s-2', 'codex', 'acct-1', '/tmp/proj', 'idle', '{"nativeSessionId":"nat-1"}', '{}', '{"workspaceMode":"chat"}', NULL, 0, 100, 200);
	`
	if _, err := raw.Exec(legacySQL); err != nil {
		t.Fatalf("seed legacy schema: %v", err)
	}
	_ = raw.Close()

	store, err := OpenStoreWithOptions(ctx, StoreOptions{
		DBPath:                  dbPath,
		EnableHistoryCompaction: false,
	})
	if err != nil {
		t.Fatalf("OpenStore legacy: %v", err)
	}
	defer func() { _ = store.Close() }()

	// Duplicate native binding detached from older s-1, kept on newer s-2; workspaceMode stripped.
	s1, err := store.RequireSession(ctx, "s-1")
	if err != nil {
		t.Fatalf("require s-1: %v", err)
	}
	if s1.ExecutionAccountRef != "acct-1" {
		t.Fatalf("expected execution_account_ref=acct-1, got %q", s1.ExecutionAccountRef)
	}
	if s1.RuntimeBinding["nativeSessionId"] != nil {
		t.Fatalf("expected older duplicate nativeSessionId detached, got %#v", s1.RuntimeBinding)
	}
	if _, hasWS := s1.Policy["workspaceMode"]; hasWS {
		t.Fatalf("expected workspaceMode stripped from policy")
	}
	s2, err := store.RequireSession(ctx, "s-2")
	if err != nil {
		t.Fatalf("require s-2: %v", err)
	}
	if s2.RuntimeBinding["nativeSessionId"] != "nat-1" {
		t.Fatalf("expected newer s-2 to keep nativeSessionId=nat-1, got %#v", s2.RuntimeBinding)
	}

	// Resolve adopts existing native binding, otherwise creates new.
	resolved, err := store.ResolveSession(ctx, CreateSessionInput{
		Provider:            "codex",
		ExecutionAccountRef: "acct-2",
		ProjectPath:         "/tmp/other",
		NativeSessionID:     "nat-1",
	})
	if err != nil {
		t.Fatalf("resolve existing native session: %v", err)
	}
	if resolved.Status != "adopted" || resolved.Session.SessionID != "s-2" {
		t.Fatalf("expected adopted s-2, got %+v", resolved)
	}

	created, err := store.ResolveSession(ctx, CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-3",
		ProjectPath:         "",
		NativeSessionID:     "nat-new",
	})
	if err != nil {
		t.Fatalf("resolve new session: %v", err)
	}
	if created.Status != "created" || created.Session.RuntimeBinding["nativeSessionId"] != "nat-new" {
		t.Fatalf("unexpected resolved create result: %+v", created)
	}

	// Delete cleans up attachment files best-effort.
	attFile := filepath.Join(t.TempDir(), "img.png")
	_ = os.WriteFile(attFile, []byte("png"), 0o600)
	_ = os.MkdirAll(VideoFramesDir(attFile), 0o700)
	_ = os.WriteFile(filepath.Join(VideoFramesDir(attFile), "frame-01.jpg"), []byte("jpg"), 0o600)
	atts, err := store.CreateAttachments(ctx, created.Session.SessionID, []AttachmentInput{{
		FilePath: attFile, Name: "img.png", MimeType: "image/png",
	}})
	if err != nil || len(atts) != 1 {
		t.Fatalf("CreateAttachments failed: %v", err)
	}
	if _, err := store.DeleteSession(ctx, created.Session.SessionID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	if _, statErr := os.Stat(attFile); !os.IsNotExist(statErr) {
		t.Fatalf("expected attachment file deleted, err=%v", statErr)
	}
	if _, statErr := os.Stat(VideoFramesDir(attFile)); !os.IsNotExist(statErr) {
		t.Fatalf("expected attachment frames dir deleted, err=%v", statErr)
	}
}

func TestStoreCommandsQueueInteractionsRecoveryAndTimeline(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)

	sess, err := store.CreateSession(ctx, CreateSessionInput{
		Provider:            "codex",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         "",
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Idempotent commands vs conflict.
	acc1, err := store.AcceptCommand(ctx, map[string]any{
		"commandId": "cmd-1",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "hello"},
	})
	if err != nil || acc1.Duplicate {
		t.Fatalf("AcceptCommand first failed: %+v, err=%v", acc1, err)
	}
	accDup, err := store.AcceptCommand(ctx, map[string]any{
		"commandId": "cmd-1",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "hello"},
	})
	if err != nil || !accDup.Duplicate {
		t.Fatalf("expected duplicate acceptance, got %+v, err=%v", accDup, err)
	}
	if _, err := store.AcceptCommand(ctx, map[string]any{
		"commandId": "cmd-1",
		"sessionId": sess.SessionID,
		"type":      "turn.submit",
		"payload":   map[string]any{"content": "different"},
	}); err == nil {
		t.Fatalf("expected conflict error")
	} else if rtErr, ok := AsRuntimeError(err); !ok || rtErr.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 conflict for divergent duplicate command, got %v", err)
	}

	// Queue enqueue, edit, move, lease with boundary guard, settle.
	q1, err := store.Enqueue(ctx, sess.SessionID, EnqueueInput{
		CommandID: "cmd-1",
		Policy:    "after_turn",
		Payload:   map[string]any{"content": "first"},
	})
	if err != nil {
		t.Fatalf("Enqueue q1: %v", err)
	}
	_, err = store.AcceptCommand(ctx, map[string]any{
		"commandId": "cmd-2",
		"sessionId": sess.SessionID,
		"type":      "queue.add",
		"payload":   map[string]any{"policy": "after_turn", "payload": map[string]any{"content": "second"}},
	})
	if err != nil {
		t.Fatalf("AcceptCommand cmd-2: %v", err)
	}
	q2, err := store.Enqueue(ctx, sess.SessionID, EnqueueInput{
		CommandID: "cmd-2",
		Policy:    "after_tool_boundary",
		Payload:   map[string]any{"content": "second"},
	})
	if err != nil {
		t.Fatalf("Enqueue q2: %v", err)
	}
	q2Moved, err := store.MoveQueueItem(ctx, q2.QueueID, q1.QueueID)
	if err != nil {
		t.Fatalf("MoveQueueItem failed: %v", err)
	}
	qList, err := store.ListQueue(ctx, sess.SessionID, true)
	if err != nil || len(qList) != 2 || qList[0].QueueID != q2.QueueID || qList[1].QueueID != q1.QueueID || q2Moved.Position != 1 {
		t.Fatalf("MoveQueueItem expected order [q2,q1], got %+v, err=%v", qList, err)
	}
	leased, err := store.LeaseQueueItem(ctx, sess.SessionID, LeaseQueueInput{
		LeaseID:        "lease-1",
		BoundaryItemID: "tool-1",
	})
	if err != nil || leased == nil || leased.QueueID != q2.QueueID {
		t.Fatalf("expected q2 leased first, got %+v, err=%v", leased, err)
	}
	// Same boundary cannot be leased twice!
	dupBoundary, err := store.LeaseQueueItem(ctx, sess.SessionID, LeaseQueueInput{
		LeaseID:        "lease-2",
		BoundaryItemID: "tool-1",
	})
	if err != nil || dupBoundary != nil {
		t.Fatalf("expected nil lease on duplicate boundaryItemId, got %+v, err=%v", dupBoundary, err)
	}

	// Begin turn with leased queue, add delta + interaction (with secret field), settle turn.
	beginRes, err := store.BeginTurn(ctx, sess.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "turn-1", RunID: "run-1", State: "starting", StartedAt: 100},
		Event: EventDraft{
			Type:    "turn.queued",
			TurnID:  "turn-1",
			RunID:   "run-1",
			Source:  EventSource{Provider: "codex", RuntimeID: "go-chat"},
			Payload: map[string]any{"submissionCommandId": "cmd-1"},
		},
		Queue: &QueueStepInput{QueueID: q2.QueueID, LeaseID: "lease-1"},
	})
	if err != nil || beginRes.Queue.Status != "running" {
		t.Fatalf("BeginTurn failed: %+v, err=%v", beginRes, err)
	}
	if _, err := store.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "timeline.item.started",
		TurnID: "turn-1",
		RunID:  "run-1",
		Source: EventSource{Provider: "codex", RuntimeID: "go-chat"},
		Payload: map[string]any{
			"item": map[string]any{
				"id":        "msg-1",
				"kind":      "message",
				"createdAt": 110,
				"status":    "running",
				"turnId":    "turn-1",
				"content":   "Hel",
				"detail":    map[string]any{"role": "assistant"},
			},
		},
	}); err != nil {
		t.Fatalf("timeline.item.started: %v", err)
	}
	if _, err := store.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "timeline.item.delta",
		TurnID: "turn-1",
		RunID:  "run-1",
		Source: EventSource{Provider: "codex", RuntimeID: "go-chat"},
		Payload: map[string]any{
			"itemId": "msg-1",
			"chunk":  "lo!",
			"detail": map[string]any{"channel": "content"},
		},
	}); err != nil {
		t.Fatalf("timeline.item.delta: %v", err)
	}

	// Interaction with secret masking & resolution events.
	inter, err := store.CreateInteraction(ctx, CreateInteractionInput{
		SessionID: sess.SessionID,
		ItemID:    "q-item-1",
		Kind:      "question",
		Revision:  1,
		Payload: map[string]any{
			"presentation":      map[string]any{"title": "Auth"},
			"answerShape":       "object",
			"confirmUnanswered": false,
			"fields": []any{
				map[string]any{"id": "apiKey", "label": "Key", "type": "text", "secret": true, "allowOther": false, "required": true},
				map[string]any{"id": "mode", "label": "Mode", "type": "single_select", "secret": false, "allowOther": false, "required": true, "options": []any{
					map[string]any{"value": "fast", "label": "快速"},
				}},
			},
			"actions": []any{"submit"},
		},
	})
	if err != nil {
		t.Fatalf("CreateInteraction: %v", err)
	}
	resPayload := ProjectInteractionResolutionForPersistence(inter, map[string]any{
		"action": "submit",
		"answer": map[string]any{"apiKey": "sk-secret-123", "mode": "fast"},
	})
	claim, err := store.ClaimInteractionResolution(ctx, inter.InteractionID, ResolveInteractionInput{
		SessionID:  sess.SessionID,
		Kind:       "question",
		Revision:   1,
		Resolution: resPayload,
	})
	if err != nil || claim.State != "resolving" {
		t.Fatalf("ClaimInteractionResolution failed: %+v, err=%v", claim, err)
	}
	finished, err := store.FinishInteractionResolution(ctx, claim)
	if err != nil || finished.State != "answered" {
		t.Fatalf("FinishInteractionResolution failed: %+v, err=%v", finished, err)
	}
	ansMap, _ := finished.Resolution["answer"].(map[string]any)
	if ansMap["apiKey"] != RedactedSecretAnswer || ansMap["mode"] != "fast" {
		t.Fatalf("expected secret masked in resolution, got %#v", ansMap)
	}

	// Settle turn with unfinished tool -> marks outcomeUnknown=true and failedTurn non-retryable.
	if _, err := store.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "timeline.item.started",
		TurnID: "turn-1",
		RunID:  "run-1",
		Source: EventSource{Provider: "codex", RuntimeID: "go-chat"},
		Payload: map[string]any{
			"item": map[string]any{
				"id":        "tool-running",
				"kind":      "tool",
				"createdAt": 120,
				"status":    "running",
				"turnId":    "turn-1",
				"detail":    map[string]any{"name": "exec", "callId": "call-9"},
			},
		},
	}); err != nil {
		t.Fatalf("tool started: %v", err)
	}
	settleRes, err := store.SettleTurn(ctx, sess.SessionID, SettleTurnInput{
		Event: EventDraft{
			Type:    "turn.failed",
			TurnID:  "turn-1",
			RunID:   "run-1",
			Source:  EventSource{Provider: "codex", RuntimeID: "go-chat"},
			Payload: map[string]any{"error": map[string]any{"code": "upstream_err", "message": "boom"}},
		},
		Queue: &QueueStepInput{
			QueueID: q2.QueueID,
			LeaseID: "lease-1",
			Outcome: "failed",
			Result:  map[string]any{"error": map[string]any{"code": "upstream_err", "message": "secret sk-abcdef1234567890"}},
		},
	})
	if err != nil {
		t.Fatalf("SettleTurn: %v", err)
	}
	if settleRes.Event.Payload["outcomeUnknown"] != true || settleRes.Session.State != "idle" {
		t.Fatalf("expected outcomeUnknown=true and idle session, got payload=%#v state=%q", settleRes.Event.Payload, settleRes.Session.State)
	}

	snap, err := store.GetSnapshot(ctx, sess.SessionID)
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if snap.FailedTurn == nil || !snap.FailedTurn.OutcomeUnknown || snap.FailedTurn.Retryable {
		t.Fatalf("expected non-retryable FailedTurn with outcomeUnknown, got %+v", snap.FailedTurn)
	}
	// Delta should have appended to msg-1 content.
	var foundMsg1, foundAnswer bool
	for _, it := range snap.Timeline {
		if it.ID == "msg-1" && it.Content != nil && *it.Content == "Hello!" {
			foundMsg1 = true
		}
		if strings.HasPrefix(it.ID, "interaction-answer:") && it.Content != nil && strings.Contains(*it.Content, "快速") {
			foundAnswer = true
		}
	}
	if !foundMsg1 || !foundAnswer {
		t.Fatalf("unexpected projected timeline: msg1=%v answer=%v items=%+v", foundMsg1, foundAnswer, snap.Timeline)
	}
}

func TestStoreBranchesAndHistoryCompaction(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)

	sess, err := store.CreateSession(ctx, CreateSessionInput{
		Provider:            "codex",
		ExecutionAccountRef: "acct-1",
		ProjectPath:         "",
		NativeSessionID:     "nat-chat-1",
		Policy:              map[string]any{"title": "主会话", "model": "gpt-5"},
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Add user message -> reasoning (with private native response item) -> assistant message.
	for _, item := range []map[string]any{
		{
			"id": "m1", "kind": "message", "createdAt": 100, "status": "completed",
			"turnId": "t1", "content": "hi", "detail": map[string]any{"role": "user"},
		},
		{
			"id": "r1", "kind": "reasoning", "createdAt": 101, "status": "completed",
			"turnId": "t1", "content": "thinking", "detail": map[string]any{},
		},
		{
			"id": "m2", "kind": "message", "createdAt": 102, "status": "completed",
			"turnId": "t1", "content": "hello", "detail": map[string]any{"role": "assistant"},
		},
	} {
		if _, err := store.AppendEvent(ctx, sess.SessionID, EventDraft{
			Type:    "timeline.item.completed",
			TurnID:  "t1",
			Source:  EventSource{Provider: "codex", RuntimeID: "go-chat"},
			Payload: map[string]any{"item": item},
		}); err != nil {
			t.Fatalf("append timeline item: %v", err)
		}
	}
	if err := store.RecordNativeResponseItem(ctx, sess.SessionID, NativeResponseItemEvidence{
		ThreadID: "nat-chat-1",
		TurnID:   "nt1",
		Item: map[string]any{
			"id":                "r1",
			"type":              "reasoning",
			"summary":           []any{map[string]any{"type": "summary_text", "text": "thinking"}},
			"encrypted_content": "enc-blob",
		},
	}); err != nil {
		t.Fatalf("RecordNativeResponseItem: %v", err)
	}

	// Fork at m2 -> succeeds and copies inherited items & seed.
	forked, err := store.BranchSession(ctx, &Command{
		CommandID: "cmd-fork-1",
		SessionID: sess.SessionID,
		Type:      "session.fork",
		Payload:   map[string]any{"sourceItemId": "m2"},
	})
	if err != nil {
		t.Fatalf("BranchSession: %v", err)
	}
	seed, err := store.ReadHistorySeed(ctx, forked.SessionID)
	if err != nil || seed == nil || len(seed.ResponseItems) != 3 {
		t.Fatalf("expected 3 responseItems in seed, got %+v, err=%v", seed, err)
	}
	page, err := store.ReadTimeline(ctx, forked.SessionID, "", 30)
	if err != nil || len(page.Items) != 3 || page.Items[0].Detail["inherited"] != true {
		t.Fatalf("unexpected forked timeline: %+v, err=%v", page, err)
	}

	// History compaction merges duplicate history rows and drops duplicate shell output.
	for _, ev := range []EventDraft{
		{
			EventID: "history-shell-1",
			Type:    "timeline.item.completed",
			Source:  EventSource{Provider: "codex", RuntimeID: "history"},
			Payload: map[string]any{
				"item": map[string]any{
					"id": "sh-1", "kind": "shell", "createdAt": 200, "updatedAt": 201, "status": "completed",
					"content": "ok\n", "detail": map[string]any{"command": "echo ok", "output": "ok\n", "callId": "call-sh-1"},
				},
			},
		},
		{
			EventID: "history-msg-a",
			Type:    "timeline.item.completed",
			Source:  EventSource{Provider: "codex", RuntimeID: "history"},
			Payload: map[string]any{
				"item": map[string]any{
					"id": "h-1", "kind": "message", "createdAt": 300, "updatedAt": 301, "status": "completed",
					"content": "same", "detail": map[string]any{"role": "assistant"},
				},
			},
		},
		{
			EventID: "history-msg-b",
			Type:    "timeline.item.completed",
			Source:  EventSource{Provider: "codex", RuntimeID: "history"},
			Payload: map[string]any{
				"item": map[string]any{
					"id": "h-1", "kind": "message", "createdAt": 300, "updatedAt": 305, "status": "completed",
					"content": "same", "detail": map[string]any{"role": "assistant"},
				},
			},
		},
	} {
		if _, err := store.AppendEvent(ctx, sess.SessionID, ev); err != nil {
			t.Fatalf("append history event: %v", err)
		}
	}

	stats, err := store.CompactStoredTimelineHistory(ctx)
	if err != nil {
		t.Fatalf("CompactStoredTimelineHistory: %v", err)
	}
	if stats.Skipped || stats.RowsCompacted != 1 || stats.RowsMerged != 1 {
		t.Fatalf("expected 1 compacted & 1 merged row, got %+v", stats)
	}
	stats2, err := store.CompactStoredTimelineHistory(ctx)
	if err != nil || !stats2.Skipped {
		t.Fatalf("expected second compaction skipped, got %+v, err=%v", stats2, err)
	}
	var shellPayloadRaw string
	if err := store.Database().withRead(ctx, func(db *sql.DB) error {
		return db.QueryRowContext(ctx, `SELECT payload_json FROM chat_runtime_events WHERE event_id = 'history-shell-1'`).Scan(&shellPayloadRaw)
	}); err != nil {
		t.Fatalf("read compacted shell row: %v", err)
	}
	var shellPayload map[string]any
	_ = json.Unmarshal([]byte(shellPayloadRaw), &shellPayload)
	itemMap, _ := shellPayload["item"].(map[string]any)
	detailMap, _ := itemMap["detail"].(map[string]any)
	if _, hasDupOut := detailMap["output"]; hasDupOut {
		t.Fatalf("expected duplicate shell detail.output dropped after compaction, got %#v", detailMap)
	}
}

type fakeNativeBranchPort struct {
	forkCalls   int
	injectCalls int
	forkErr     error
	injectErr   error
}

func (f *fakeNativeBranchPort) Fork(_ context.Context, op *BranchOperation) (map[string]any, error) {
	f.forkCalls++
	if f.forkErr != nil {
		return nil, f.forkErr
	}
	return map[string]any{"threadId": "thread-forked", "sourceThreadId": op.SourceThreadID}, nil
}

func (f *fakeNativeBranchPort) RecoverFork(_ context.Context, op *BranchOperation) (map[string]any, error) {
	return map[string]any{"threadId": "thread-forked", "sourceThreadId": op.SourceThreadID}, nil
}

func (f *fakeNativeBranchPort) Inject(_ context.Context, _ *BranchOperation) error {
	f.injectCalls++
	return f.injectErr
}

func (f *fakeNativeBranchPort) RecoverInjection(_ context.Context, _ *BranchOperation) (string, error) {
	return "complete", nil
}

func TestStoreRecoveryAndWorkBranchCheckpoints(t *testing.T) {
	ctx := context.Background()
	store, _ := openTestStore(t)

	sess, err := store.CreateSession(ctx, CreateSessionInput{
		Provider:            "codex",
		ExecutionAccountRef: "acct-work",
		ProjectPath:         "/tmp/project",
		NativeSessionID:     "thread-orig",
		Policy:              map[string]any{"title": "工作区"},
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := store.BeginTurn(ctx, sess.SessionID, BeginTurnInput{
		ActiveTurn: &ActiveTurn{TurnID: "turn-r", RunID: "run-r", State: "running", StartedAt: 100},
		Event: EventDraft{
			Type:    "turn.started",
			TurnID:  "turn-r",
			RunID:   "run-r",
			Source:  EventSource{Provider: "codex", RuntimeID: "codex"},
			Payload: map[string]any{},
		},
	}); err != nil {
		t.Fatalf("BeginTurn: %v", err)
	}

	cands, err := store.ListRecoveryCandidates(ctx)
	if err != nil || len(cands) != 1 || cands[0].SessionID != sess.SessionID {
		t.Fatalf("expected 1 recovery candidate, got %+v, err=%v", cands, err)
	}
	rec, err := store.BeginRestartRecovery(ctx, sess.SessionID)
	if err != nil || !rec.Recoverable || rec.Session.State != "recovering" {
		t.Fatalf("BeginRestartRecovery failed: %+v, err=%v", rec, err)
	}
	reattached, err := store.CompleteRestartRecovery(ctx, sess.SessionID, CompleteRecoveryInput{NativeTurnID: "nt-1"})
	if err != nil || reattached.Session.State != "running" || reattached.ActiveTurn.NativeTurnID != "nt-1" {
		t.Fatalf("CompleteRestartRecovery failed: %+v, err=%v", reattached, err)
	}
	lostSess, err := store.FailRestartRecovery(ctx, sess.SessionID, map[string]any{"code": "lost", "message": "process died"})
	if err != nil || lostSess.State != "idle" || lostSess.ActiveTurn != nil {
		t.Fatalf("FailRestartRecovery failed: %+v, err=%v", lostSess, err)
	}

	// Work branch Capture + PrepareNativeBranch + Commit.
	for _, ev := range []EventDraft{
		{
			Type: "timeline.item.completed", TurnID: "tw1", Source: EventSource{Provider: "codex", RuntimeID: "codex"},
			Payload: map[string]any{"item": map[string]any{
				"id": "wm1", "kind": "message", "createdAt": 200, "status": "completed",
				"turnId": "tw1", "content": "check code", "detail": map[string]any{"role": "user"},
			}},
		},
		{
			Type: "timeline.item.completed", TurnID: "tw1", Source: EventSource{Provider: "codex", RuntimeID: "codex"},
			Payload: map[string]any{"item": map[string]any{
				"id": "wm2", "kind": "message", "createdAt": 210, "status": "completed",
				"turnId": "tw1", "content": "looks good", "detail": map[string]any{"role": "assistant"},
			}},
		},
	} {
		if _, err := store.AppendEvent(ctx, sess.SessionID, ev); err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
	}

	forkCmdRes, err := store.AcceptCommand(ctx, map[string]any{
		"commandId": "cmd-wfork-1",
		"sessionId": sess.SessionID,
		"type":      "session.fork",
		"payload":   map[string]any{"sourceItemId": "wm2"},
	})
	if err != nil {
		t.Fatalf("AcceptCommand fork: %v", err)
	}
	capRes, err := store.WorkBranches.Capture(ctx, forkCmdRes.Command)
	if err != nil || len(capRes.Items) != 2 {
		t.Fatalf("WorkBranches.Capture failed: %+v, err=%v", capRes, err)
	}
	plan := map[string]any{
		"threadId":     "thread-orig",
		"sourceItemId": "wm2",
		"beforeTurnId": "nt-after",
		"items":        []any{map[string]any{"type": "user", "text": "check code"}},
		"nativeTurns": []any{
			map[string]any{
				"id":       "nt-1",
				"coverage": "complete",
				"items":    []any{map[string]any{"id": "raw-1", "type": "message", "role": "user"}},
			},
		},
		"projection": map[string]any{
			"items":              capRes.Items,
			"submissions":        capRes.Submissions,
			"interactions":       capRes.Interactions,
			"projectPath":        capRes.ProjectPath,
			"policy":             capRes.Policy,
			"capabilitySnapshot": capRes.CapabilitySnapshot,
			"runtimeBinding":     capRes.RuntimeBinding,
		},
	}
	port := &fakeNativeBranchPort{}
	op, err := PrepareNativeBranch(ctx, store.BranchOperations, forkCmdRes.Command, plan, port)
	if err != nil || op.State != "ready" {
		t.Fatalf("PrepareNativeBranch failed: %+v, err=%v", op, err)
	}
	child, err := store.WorkBranches.Commit(ctx, forkCmdRes.Command)
	if err != nil || asString(child.RuntimeBinding["nativeSessionId"]) != "thread-forked" {
		t.Fatalf("WorkBranches.Commit failed: %+v, err=%v", child, err)
	}
}
