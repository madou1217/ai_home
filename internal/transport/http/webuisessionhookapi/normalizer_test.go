package webuisessionhookapi

import (
	"testing"
	"time"
)

func TestNormalizeProviderHookEventVariants(t *testing.T) {
	fixedNow := func() time.Time { return time.UnixMilli(1700000000000) }
	isSupported := func(p string) bool {
		return p == "claude" || p == "codex" || p == "agy" || p == "gemini"
	}

	cases := []struct {
		name      string
		provider  string
		payload   map[string]any
		options   NormalizeOptions
		wantErr   string
		wantType  string
		wantPhase string
		wantSess  string
		wantQ     string
		wantErrTx string
	}{
		{
			name:     "Claude PermissionRequest 提取命令描述",
			provider: "Claude",
			payload: map[string]any{
				"hook_event_name": "PermissionRequest",
				"session_id":      "c-1",
				"tool_name":       "Bash",
				"tool_input":      map[string]any{"command": "ls -la"},
			},
			wantType:  "question-opened",
			wantPhase: "turn-updated",
			wantSess:  "c-1",
			wantQ:     "Bash: ls -la",
		},
		{
			name:     "Claude Notification waiting vs info",
			provider: "claude",
			payload: map[string]any{
				"hook_event_name":   "Notification",
				"session_id":        "c-2",
				"notification_type": "idle_prompt",
				"message":           "Waiting for input",
			},
			wantType:  "question-opened",
			wantPhase: "turn-updated",
			wantSess:  "c-2",
			wantQ:     "Waiting for input",
		},
		{
			name:     "Claude Notification 普通信息",
			provider: "claude",
			payload: map[string]any{
				"hook_event_name":   "Notification",
				"session_id":        "c-3",
				"notification_type": "auth_success",
			},
			wantType:  "session:notification",
			wantPhase: "notification",
			wantSess:  "c-3",
		},
		{
			name:     "Claude Statusline 负载归一",
			provider: "claude",
			payload: map[string]any{
				"eventName":  "Statusline",
				"sessionId":  "c-4",
				"statusline": map[string]any{"contextPct": float64(68), "tokens": float64(12000)},
			},
			wantType:  "statusline-updated",
			wantPhase: "turn-updated",
			wantSess:  "c-4",
		},
		{
			name:     "AGY 推断 Stop error",
			provider: "agy",
			payload: map[string]any{
				"conversationId":    "agy-1",
				"executionNum":      float64(3),
				"terminationReason": "error",
				"error":             "upstream failed",
				"workspacePaths":    []any{"/tmp/agy-ws"},
			},
			wantType:  "session:turn-failed",
			wantPhase: "turn-failed",
			wantSess:  "agy-1",
			wantErrTx: "upstream failed",
		},
		{
			name:     "AGY 推断 PreToolUse",
			provider: "agy",
			payload: map[string]any{
				"conversationId": "agy-2",
				"toolCall":       map[string]any{"name": "read"},
			},
			wantType:  "session:turn-updated",
			wantPhase: "turn-updated",
			wantSess:  "agy-2",
		},
		{
			name:     "不支持的 Provider",
			provider: "unknown",
			payload:  map[string]any{"sessionId": "x"},
			wantErr:  "unsupported_provider",
		},
		{
			name:     "缺少 sessionId",
			provider: "codex",
			payload:  map[string]any{"eventName": "Stop"},
			wantErr:  "missing_session_id",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.options
			opts.Now = fixedNow
			opts.IsSupportedProvider = isSupported
			got := NormalizeProviderHookEvent(tc.provider, tc.payload, opts)
			if tc.wantErr != "" {
				if got.OK || got.Error != tc.wantErr {
					t.Fatalf("got ok=%v err=%q, want err=%q", got.OK, got.Error, tc.wantErr)
				}
				return
			}
			if !got.OK {
				t.Fatalf("期望归一成功, got err=%q", got.Error)
			}
			if got.Event.Type != tc.wantType || got.Event.Phase != tc.wantPhase || got.Session.SessionID != tc.wantSess {
				t.Fatalf("归一不符: session=%+v event=%+v", got.Session, got.Event)
			}
			if tc.wantQ != "" && got.Event.Payload["question"] != tc.wantQ {
				t.Fatalf("question = %v, want %q", got.Event.Payload["question"], tc.wantQ)
			}
			if tc.wantErrTx != "" && got.Event.Payload["error"] != tc.wantErrTx {
				t.Fatalf("error = %v, want %q", got.Event.Payload["error"], tc.wantErrTx)
			}
		})
	}
}
