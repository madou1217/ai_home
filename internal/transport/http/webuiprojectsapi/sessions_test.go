package webuiprojectsapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// doSessionsRequest 用契约路径发起单项目全量读请求；projectPath 为空时不带查询参数。
func doSessionsRequest(t *testing.T, handler http.Handler, method, projectPath string) *httptest.ResponseRecorder {
	t.Helper()
	target := SessionsPath
	if projectPath != "" {
		target += "?projectPath=" + url.QueryEscape(projectPath)
	}
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeProjectSessions(t *testing.T, recorder *httptest.ResponseRecorder) projectResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200, body=%s", recorder.Code, recorder.Body.String())
	}
	var body projectResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v, body=%s", err, recorder.Body.String())
	}
	if !body.OK {
		t.Fatalf("ok = false, body=%s", recorder.Body.String())
	}
	return body
}

// TestSessionsHandlerReturnsCompleteProject 验证按 projectPath 只下发目标项目，
// 且会话集合不受列表接口的 40 条截断影响。
func TestSessionsHandlerReturnsCompleteProject(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "complete")
	otherProject := newProjectDir(t, "other")
	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)

	total := sessionPayloadCap + 5
	for index := 0; index < total; index++ {
		writeClaudeSession(
			t,
			hostHome,
			"claude-complete",
			fmt.Sprintf("session-%02d", index),
			projectDir,
			fmt.Sprintf("会话 %02d", index),
			base.Add(time.Duration(index)*time.Minute),
		)
	}
	// 同一路径的 Codex 会话必须并入同一个项目，并成为最新一条。
	writeCodexSession(t, hostHome, "codex-complete", projectDir, "Codex 最新会话", base.Add(time.Duration(total)*time.Minute))
	writeClaudeSession(t, hostHome, "claude-other", "other-session", otherProject, "别的项目会话", base.Add(24*time.Hour))

	handler := newTestHandler(t, hostHome, true)
	// 尾部斜杠必须被归一化，与 Node normalizeProjectPath 同口径。
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir+"/"))

	project := body.Project
	if project.Path != projectDir {
		t.Fatalf("项目路径 = %q, 期望 %q", project.Path, projectDir)
	}
	if strings.Join(project.Providers, ",") != "claude,codex" {
		t.Fatalf("providers = %v, 期望 [claude codex]", project.Providers)
	}
	wantTotal := total + 1
	if project.SessionTotal != wantTotal {
		t.Fatalf("sessionTotal = %d, 期望 %d", project.SessionTotal, wantTotal)
	}
	if len(project.Sessions) != wantTotal {
		t.Fatalf("下发会话数 = %d, 期望完整 %d 条", len(project.Sessions), wantTotal)
	}
	if project.Sessions[0].ID != "codex-complete" {
		t.Fatalf("首条会话 = %q, 期望最新的 codex-complete", project.Sessions[0].ID)
	}
	for _, session := range project.Sessions {
		if session.ProjectPath != projectDir {
			t.Fatalf("会话 %s 的 projectPath = %q, 期望 %q", session.ID, session.ProjectPath, projectDir)
		}
		if session.ProjectDirName == "" {
			t.Fatalf("会话 %s 缺少 projectDirName", session.ID)
		}
	}
	if got := project.Sessions[wantTotal-1].ID; got != "session-00" {
		t.Fatalf("末条会话 = %q, 期望最旧的 session-00", got)
	}
}

func TestSessionsHandlerRequiresProjectPath(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doSessionsRequest(t, handler, http.MethodGet, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, 期望 400, body=%s", recorder.Code, recorder.Body.String())
	}
	var body errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body.Error != "missing_projectPath" {
		t.Fatalf("error = %q, 期望 missing_projectPath", body.Error)
	}
}

func TestSessionsHandlerUnknownProjectReturnsNotFound(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	emptyDir := newProjectDir(t, "empty")
	recorder := doSessionsRequest(t, handler, http.MethodGet, emptyDir)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("状态码 = %d, 期望 404, body=%s", recorder.Code, recorder.Body.String())
	}
	var body errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body.Error != "project_not_found" {
		t.Fatalf("error = %q, 期望 project_not_found", body.Error)
	}
}

// TestSessionsHandlerRejectsTruncatedScan 验证全量读遇到预算截断时返回 503，
// 让 Node 回退本地索引，而不是下发半份会话集。
func TestSessionsHandlerRejectsTruncatedScan(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "truncated")
	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	writeClaudeSession(t, hostHome, "claude-truncated", "session", projectDir, "预算会话", base)

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.MaxEntries = 1
	})
	recorder := doSessionsRequest(t, handler, http.MethodGet, projectDir)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d, 期望 503, body=%s", recorder.Code, recorder.Body.String())
	}
	var body errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body.Error != "project_sessions_unavailable" {
		t.Fatalf("error = %q, 期望 project_sessions_unavailable", body.Error)
	}
}

func TestSessionsHandlerRejectsNonGet(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doSessionsRequest(t, handler, http.MethodPost, "/whatever")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d, 期望 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow = %q, 期望 GET", got)
	}
}
