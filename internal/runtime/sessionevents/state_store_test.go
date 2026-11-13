package sessionevents

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStateStoreTransitionsAndPersistenceParity(t *testing.T) {
	aiHome := t.TempDir()
	now := int64(1700000100000)
	store := NewStateStore(StateStoreOptions{
		AIHomeDir: aiHome,
		Now:       func() time.Time { return time.UnixMilli(now) },
	})

	sess := StateSession{
		Provider:    "Claude",
		SessionID:   "sess-state-1",
		ProjectPath: "/tmp/proj",
	}

	res := store.Apply(StateEvent{
		Session:       sess,
		CorrelationID: "corr-1",
		EventID:       "ev-1",
		Type:          "session:turn-started",
		Source:        "official-hook",
		At:            now,
	})
	if !res.Accepted || res.State == nil || res.State.TurnState != "working" {
		t.Fatalf("turn-started 失败: %+v", res)
	}

	// 验证磁盘文件命名规则与 Node JSON.stringify({provider,sessionId,projectPath,projectDirName}) 完全一致
	expectedRaw := `{"provider":"claude","sessionId":"sess-state-1","projectPath":"/tmp/proj","projectDirName":""}`
	sum := sha256.Sum256([]byte(expectedRaw))
	statePath := filepath.Join(aiHome, "run", "provider-session-state", hex.EncodeToString(sum[:])+".json")
	rawBytes, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("读取持久化状态失败 %s: %v", statePath, err)
	}
	var diskState map[string]any
	if err := json.Unmarshal(rawBytes, &diskState); err != nil {
		t.Fatalf("解析状态 JSON 失败: %v", err)
	}
	if diskState["turnState"] != "working" {
		t.Fatalf("磁盘状态 turnState = %v, want working", diskState["turnState"])
	}

	// question-opened 与通用 notice 不覆盖已有具体问题
	res = store.Apply(StateEvent{
		Session: sess,
		EventID: "ev-q1",
		Type:    "session:question-opened",
		At:      now + 10,
		Payload: map[string]any{"question": "Bash: rm -rf /tmp/x"},
	})
	if !res.Accepted || res.State.TurnState != "waiting" || res.State.Question == nil || res.State.Question.Question != "Bash: rm -rf /tmp/x" {
		t.Fatalf("question-opened 失败: %+v", res)
	}
	res = store.Apply(StateEvent{
		Session: sess,
		EventID: "ev-q2",
		Type:    "session:question-opened",
		At:      now + 20,
		Payload: map[string]any{"question": "Claude needs permission", "notice": true},
	})
	if !res.Accepted || res.State.Question.Question != "Bash: rm -rf /tmp/x" {
		t.Fatalf("notice=true 不应覆盖已有问题: %+v", res.State)
	}

	// 重复事件拦截
	dup := store.Apply(StateEvent{
		Session: sess,
		EventID: "ev-q2",
		Type:    "session:question-opened",
		At:      now + 21,
	})
	if dup.Accepted || dup.Reason != "duplicate_event" {
		t.Fatalf("期望 duplicate_event, got=%+v", dup)
	}

	// correlation 冲突拦截
	conflict := store.Apply(StateEvent{
		Session: StateSession{Provider: "claude", SessionID: "sess-other"},
		CorrelationID: "corr-1",
		EventID:       "ev-conflict",
		Type:          "session:opened",
		At:            now + 30,
	})
	if conflict.Accepted || conflict.Reason != "correlation_conflict" {
		t.Fatalf("期望 correlation_conflict, got=%+v", conflict)
	}

	// pending 队列在 correlation 绑定后自动排空
	pendingRes := store.ApplyByCorrelation("corr-late", StateEvent{
		EventID: "ev-pending-1",
		Type:    "session:turn-completed",
		At:      now + 50,
	})
	if pendingRes.Accepted || pendingRes.Reason != "pending_correlation" {
		t.Fatalf("未绑定时应进入 pending_correlation: %+v", pendingRes)
	}
	if store.BindCorrelation("corr-late", StateSession{Provider: "codex", SessionID: "sess-late"}) {
		t.Fatal("新绑定不应冲突")
	}
	lateState, ok := store.Get(StateSession{Provider: "codex", SessionID: "sess-late"})
	if !ok || lateState.TurnState != "completed" {
		t.Fatalf("BindCorrelation 后应排空 pending 事件并变为 completed, got=%+v ok=%v", lateState, ok)
	}
}

func TestNormalizeRetryStatus(t *testing.T) {
	got := NormalizeRetryStatus(map[string]any{
		"attempt":      2,
		"maxAttempts":  "5",
		"retryAfterMs": 1500,
		"status":       429,
		"reason":       " rate_limit ",
		"message":      "retry soon",
	}, "Codex")
	if got.Type != "retry-status" || got.Provider != "codex" || got.Attempt != 2 || got.MaxAttempts != 5 {
		t.Fatalf("重试状态归一错误: %+v", got)
	}
	if got.RetryAfterMs == nil || *got.RetryAfterMs != 1500 || got.Status == nil || *got.Status != 429 {
		t.Fatalf("数值字段缺失: %+v", got)
	}
}
