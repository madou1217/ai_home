package webuisessionslifecycleapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestUnarchiveClaudeAndConflictAndNotFound(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, ".claude", "projects", "proj-1")
	archivedDir := filepath.Join(projectDir, archiveDirName)
	if err := os.MkdirAll(archivedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	archivedFile := filepath.Join(archivedDir, "sess-1.jsonl")
	activeFile := filepath.Join(projectDir, "sess-1.jsonl")
	if err := os.WriteFile(archivedFile, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := newTestHandler(t, hostHome, Dependencies{})

	// 1. 成功恢复 Claude 历史归档
	rec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"claude","sessionId":"sess-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("Claude 恢复状态码 = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var body archiveResponse
	decodeBody(t, rec, &body)
	if !body.OK || body.Origin != originLegacy || body.Provider != providerClaude || body.SessionID != "sess-1" {
		t.Fatalf("Claude 恢复响应不符: %+v", body)
	}
	if _, err := os.Stat(activeFile); err != nil {
		t.Fatalf("恢复后活动文件应存在: %v", err)
	}
	if _, err := os.Stat(archivedFile); !os.IsNotExist(err) {
		t.Fatalf("恢复后归档文件应已移出: err=%v", err)
	}

	// 2. 冲突：目标活动文件已存在且有归档副本
	if err := os.WriteFile(archivedFile, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	conflictRec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"claude","sessionId":"sess-1","origin":"legacy"}`)
	if conflictRec.Code != http.StatusConflict {
		t.Fatalf("冲突状态码 = %d, want 409 (body=%s)", conflictRec.Code, conflictRec.Body.String())
	}
	var errBody errorResponse
	decodeBody(t, conflictRec, &errBody)
	if errBody.Error != codeLegacyArchiveRestoreConflict {
		t.Fatalf("冲突错误码 = %q, want %q", errBody.Error, codeLegacyArchiveRestoreConflict)
	}

	// 3. 未找到归档
	notFoundRec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"claude","sessionId":"missing-1"}`)
	if notFoundRec.Code != http.StatusNotFound {
		t.Fatalf("未找到状态码 = %d, want 404 (body=%s)", notFoundRec.Code, notFoundRec.Body.String())
	}
	decodeBody(t, notFoundRec, &errBody)
	if errBody.Error != codeLegacyArchiveNotFound {
		t.Fatalf("未找到错误码 = %q, want %q", errBody.Error, codeLegacyArchiveNotFound)
	}
}

func TestUnarchiveGeminiMatchesSessionID(t *testing.T) {
	hostHome := t.TempDir()
	chatsDir := filepath.Join(hostHome, ".gemini", "tmp", "hash-1", "chats")
	archivedDir := filepath.Join(chatsDir, archiveDirName)
	if err := os.MkdirAll(archivedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	archivedFile := filepath.Join(archivedDir, "session-2026-11-10.json")
	if err := os.WriteFile(archivedFile, []byte(`{"sessionId":"gem-99","messages":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := newTestHandler(t, hostHome, Dependencies{})
	rec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"gemini","sessionId":"gem-99"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("Gemini 恢复状态码 = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var body archiveResponse
	decodeBody(t, rec, &body)
	if body.Origin != originLegacy || body.Provider != providerGemini || body.SessionID != "gem-99" {
		t.Fatalf("Gemini 响应不符: %+v", body)
	}
	if _, err := os.Stat(filepath.Join(chatsDir, "session-2026-11-10.json")); err != nil {
		t.Fatalf("恢复后的 Gemini 文件应存在: %v", err)
	}
}

func TestUnarchiveCodexAndUnsupported(t *testing.T) {
	client := &fakeCodexClient{}
	handler := newTestHandler(t, t.TempDir(), Dependencies{
		Codex: func(context.Context) (CodexClient, error) { return client, nil },
	})

	rec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"codex","sessionId":"thread-7"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("Codex 恢复状态码 = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var body archiveResponse
	decodeBody(t, rec, &body)
	if body.Origin != originNative || body.NativeSessionID != "thread-7" {
		t.Fatalf("Codex 响应不符: %+v", body)
	}
	if len(client.unarchived) != 1 || client.unarchived[0] != "thread-7" || client.closeCount != 1 {
		t.Fatalf("Codex 客户端调用异常: unarchived=%v closeCount=%d", client.unarchived, client.closeCount)
	}

	// Codex RPC 失败返回 502
	errHandler := newTestHandler(t, t.TempDir(), Dependencies{
		Codex: func(context.Context) (CodexClient, error) {
			return &fakeCodexClient{unarchiveErr: errors.New("boom")}, nil
		},
	})
	errRec := performRequest(errHandler, http.MethodPost, UnarchivePath, `{"provider":"codex","sessionId":"thread-7"}`)
	if errRec.Code != http.StatusBadGateway {
		t.Fatalf("Codex RPC 失败状态码 = %d, want 502", errRec.Code)
	}

	// 不支持的 Provider 返回 422
	unsupRec := performRequest(handler, http.MethodPost, UnarchivePath, `{"provider":"opencode","sessionId":"oc-1"}`)
	if unsupRec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("不支持恢复状态码 = %d, want 422", unsupRec.Code)
	}
	var errBody errorResponse
	decodeBody(t, unsupRec, &errBody)
	if errBody.Error != codeSessionUnarchiveUnsupported {
		t.Fatalf("错误码 = %q, want %q", errBody.Error, codeSessionUnarchiveUnsupported)
	}

	// 错误方法返回 405 + Allow: POST
	getRec := performRequest(handler, http.MethodGet, UnarchivePath, "")
	if getRec.Code != http.StatusMethodNotAllowed || getRec.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("方法校验失败: code=%d allow=%q", getRec.Code, getRec.Header().Get("Allow"))
	}
}
