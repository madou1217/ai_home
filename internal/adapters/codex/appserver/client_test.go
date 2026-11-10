package appserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	fakeModeEnv = "AIH_FAKE_APPSERVER_MODE"
	fakeLogEnv  = "AIH_FAKE_APPSERVER_LOG"
	fakeMarker  = "AIH_FAKE_APPSERVER"
)

// TestFakeAppServerProcess 是假 app-server：同一测试二进制带标记重新执行时，
// 只跑 NDJSON 服务循环，不进入任何断言。
func TestFakeAppServerProcess(t *testing.T) {
	if os.Getenv(fakeMarker) != "1" {
		return
	}
	runFakeAppServer()
	os.Exit(0)
}

func runFakeAppServer() {
	mode := os.Getenv(fakeModeEnv)
	if mode == "exit-immediately" {
		os.Exit(3)
	}
	var logFile *os.File
	if logPath := os.Getenv(fakeLogEnv); logPath != "" {
		logFile, _ = os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	}
	writer := bufio.NewWriter(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)

	respond := func(id json.RawMessage, result any) {
		if len(id) == 0 {
			return
		}
		payload, err := json.Marshal(map[string]any{"id": id, "result": result})
		if err != nil {
			return
		}
		_, _ = writer.Write(append(payload, '\n'))
		_ = writer.Flush()
	}
	fail := func(id json.RawMessage, code int, message string) {
		if len(id) == 0 {
			return
		}
		payload, err := json.Marshal(map[string]any{
			"id":    id,
			"error": map[string]any{"code": code, "message": message},
		})
		if err != nil {
			return
		}
		_, _ = writer.Write(append(payload, '\n'))
		_ = writer.Flush()
	}

	type request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	type listParamsWire struct {
		Archived       bool     `json:"archived"`
		Cursor         *string  `json:"cursor"`
		Limit          int      `json:"limit"`
		ModelProviders []string `json:"modelProviders"`
		SourceKinds    []string `json:"sourceKinds"`
		UseStateDBOnly bool     `json:"useStateDbOnly"`
	}
	type threadParamsWire struct {
		ThreadID string `json:"threadId"`
	}

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if logFile != nil {
			_, _ = logFile.Write(append(append([]byte{}, line...), '\n'))
		}
		var message request
		if err := json.Unmarshal(line, &message); err != nil {
			continue
		}
		switch message.Method {
		case "initialize":
			respond(message.ID, map[string]any{
				"userAgent":      "fake-codex/1.0",
				"codexHome":      "/tmp/fake-codex-home",
				"platformFamily": "unix",
			})
		case "initialized":
		case "thread/list":
			if mode == "missing-list" || mode == "missing-all" {
				fail(message.ID, codeMethodNotFound, "method not found")
				continue
			}
			if mode == "silent" {
				continue
			}
			if mode == "repeat-cursor" {
				respond(message.ID, map[string]any{"data": []any{}, "nextCursor": "same"})
				continue
			}
			var params listParamsWire
			_ = json.Unmarshal(message.Params, &params)
			if params.Cursor != nil && *params.Cursor == "page-2" {
				respond(message.ID, map[string]any{
					"data": []any{map[string]any{
						"id":        "thread-3",
						"name":      "",
						"preview":   "",
						"updatedAt": 0,
					}},
					"nextCursor": nil,
				})
				continue
			}
			respond(message.ID, map[string]any{
				"data": []any{
					map[string]any{
						"id":        "thread-1",
						"name":      "修复登录",
						"preview":   "preview-1",
						"cwd":       "/tmp/work",
						"updatedAt": 1700000000,
					},
					map[string]any{
						"id":        "thread-2",
						"name":      "",
						"preview":   "预演标题",
						"updatedAt": 1700000000.5,
					},
				},
				"nextCursor": "page-2",
			})
		case "thread/archive", "thread/unarchive":
			if mode == "missing-all" {
				fail(message.ID, codeMethodNotFound, "method not found")
				continue
			}
			if mode == "missing-unarchive" && message.Method == "thread/unarchive" {
				fail(message.ID, codeMethodNotFound, "method not found")
				continue
			}
			if mode == "not-found" {
				var params threadParamsWire
				_ = json.Unmarshal(message.Params, &params)
				fail(message.ID, -32000, "thread not found: "+params.ThreadID)
				continue
			}
			respond(message.ID, map[string]any{})
		default:
			fail(message.ID, codeMethodNotFound, "method not found")
		}
	}
	if logFile != nil {
		_ = logFile.Close()
	}
}

type loggedRequest struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
}

func startFakeClient(t *testing.T, mode string) (*Client, string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	logPath := filepath.Join(t.TempDir(), "requests.jsonl")
	env := append(os.Environ(),
		fakeMarker+"=1",
		fakeModeEnv+"="+mode,
		fakeLogEnv+"="+logPath,
	)
	client, err := Dial(context.Background(), Config{
		Command:        executable,
		Args:           []string{"-test.run=^TestFakeAppServerProcess$"},
		Env:            env,
		RequestTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("dial fake app-server: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, logPath
}

func readRequestLog(t *testing.T, path string) []loggedRequest {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request log: %v", err)
	}
	requests := make([]loggedRequest, 0)
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var request loggedRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatalf("decode request log line %q: %v", line, err)
		}
		requests = append(requests, request)
	}
	return requests
}

func TestListArchivedThreadsMapsAndPaginates(t *testing.T) {
	client, logPath := startFakeClient(t, "full")
	threads, err := client.ListArchivedThreads(context.Background())
	if err != nil {
		t.Fatalf("list archived threads: %v", err)
	}
	if len(threads) != 3 {
		t.Fatalf("want 3 threads, got %d: %+v", len(threads), threads)
	}
	first := threads[0]
	if first.ID != "thread-1" || first.Title != "修复登录" ||
		first.ProjectPath != "/tmp/work" || first.UpdatedAt != 1700000000000 {
		t.Fatalf("unexpected first thread: %+v", first)
	}
	if first.Provider != "codex" || first.Origin != "native" || !first.CanUnarchive {
		t.Fatalf("unexpected thread origin fields: %+v", first)
	}
	if threads[1].Title != "预演标题" || threads[1].ProjectPath != "" ||
		threads[1].UpdatedAt != 1700000000500 {
		t.Fatalf("unexpected preview fallback thread: %+v", threads[1])
	}
	if threads[2].Title != unnamedThreadTitle || threads[2].UpdatedAt != 0 {
		t.Fatalf("unexpected unnamed thread: %+v", threads[2])
	}

	requests := readRequestLog(t, logPath)
	if len(requests) < 4 {
		t.Fatalf("want initialize + initialized + 2 pages, got %d", len(requests))
	}
	if requests[0].Method != "initialize" || requests[1].Method != "initialized" {
		t.Fatalf("unexpected handshake order: %q, %q", requests[0].Method, requests[1].Method)
	}
	var initializeParams map[string]any
	if err := json.Unmarshal(requests[0].Params, &initializeParams); err != nil {
		t.Fatalf("decode initialize params: %v", err)
	}
	clientInfo, _ := initializeParams["clientInfo"].(map[string]any)
	if clientInfo["name"] != "aih-go" {
		t.Fatalf("unexpected clientInfo: %v", clientInfo)
	}
	capabilities, _ := initializeParams["capabilities"].(map[string]any)
	if capabilities["experimentalApi"] != true {
		t.Fatalf("experimentalApi not negotiated: %v", capabilities)
	}

	firstPage := decodeListParams(t, requests[2])
	if requests[2].Method != "thread/list" || !firstPage.Archived || firstPage.Limit != listPageSize ||
		firstPage.Cursor != nil || firstPage.UseStateDBOnly {
		t.Fatalf("unexpected first page params: %s", requests[2].Params)
	}
	secondPage := decodeListParams(t, requests[3])
	if secondPage.Cursor == nil || *secondPage.Cursor != "page-2" {
		t.Fatalf("unexpected second page cursor: %s", requests[3].Params)
	}
}

func decodeListParams(t *testing.T, request loggedRequest) listParams {
	t.Helper()
	var params listParams
	if err := json.Unmarshal(request.Params, &params); err != nil {
		t.Fatalf("decode thread/list params: %v", err)
	}
	return params
}

func TestArchiveAndUnarchiveSendTrimmedThreadID(t *testing.T) {
	client, logPath := startFakeClient(t, "full")
	ctx := context.Background()
	if err := client.ArchiveThread(ctx, "  thread-9  "); err != nil {
		t.Fatalf("archive thread: %v", err)
	}
	if err := client.UnarchiveThread(ctx, "thread-9"); err != nil {
		t.Fatalf("unarchive thread: %v", err)
	}
	if err := client.ArchiveThread(ctx, "   "); !errors.Is(err, ErrMissingThreadID) {
		t.Fatalf("want ErrMissingThreadID, got %v", err)
	}

	requests := readRequestLog(t, logPath)
	archive := requests[len(requests)-2]
	unarchive := requests[len(requests)-1]
	if archive.Method != "thread/archive" || unarchive.Method != "thread/unarchive" {
		t.Fatalf("unexpected methods: %q, %q", archive.Method, unarchive.Method)
	}
	for _, request := range []loggedRequest{archive, unarchive} {
		var params threadParams
		if err := json.Unmarshal(request.Params, &params); err != nil {
			t.Fatalf("decode thread params: %v", err)
		}
		if params.ThreadID != "thread-9" {
			t.Fatalf("%s sent threadId %q", request.Method, params.ThreadID)
		}
	}
}

func TestProbeCapabilitiesReportsNativeWorkflow(t *testing.T) {
	client, _ := startFakeClient(t, "full")
	capabilities, err := client.ProbeCapabilities(context.Background())
	if err != nil {
		t.Fatalf("probe capabilities: %v", err)
	}
	if !capabilities.WorkflowAvailable || capabilities.Reason != "" {
		t.Fatalf("unexpected capabilities: %+v", capabilities)
	}
	if capabilities.Provider != "codex" ||
		capabilities.Operations.Archive.Support != SupportNative ||
		capabilities.Operations.ListArchived.Support != SupportNative ||
		capabilities.Operations.Unarchive.Support != SupportNative {
		t.Fatalf("unexpected operations: %+v", capabilities.Operations)
	}
}

func TestProbeCapabilitiesMarksMissingUnarchive(t *testing.T) {
	client, _ := startFakeClient(t, "missing-unarchive")
	capabilities, err := client.ProbeCapabilities(context.Background())
	if err != nil {
		t.Fatalf("probe capabilities: %v", err)
	}
	if capabilities.WorkflowAvailable || capabilities.Reason != ReasonWorkflowIncomplete {
		t.Fatalf("unexpected capabilities: %+v", capabilities)
	}
	unarchive := capabilities.Operations.Unarchive
	if unarchive.Available || unarchive.Support != SupportUnsupported || unarchive.Reason != ReasonMethodUnavailable {
		t.Fatalf("unexpected unarchive operation: %+v", unarchive)
	}
	if !capabilities.Operations.Archive.Available {
		t.Fatalf("archive should stay available: %+v", capabilities.Operations.Archive)
	}
}

func TestProbeCapabilitiesTreatsBusinessErrorAsAvailable(t *testing.T) {
	client, _ := startFakeClient(t, "not-found")
	capabilities, err := client.ProbeCapabilities(context.Background())
	if err != nil {
		t.Fatalf("probe capabilities: %v", err)
	}
	if !capabilities.WorkflowAvailable {
		t.Fatalf("business error must not mean method missing: %+v", capabilities)
	}
}

func TestProbeCapabilitiesAllMissing(t *testing.T) {
	client, _ := startFakeClient(t, "missing-all")
	capabilities, err := client.ProbeCapabilities(context.Background())
	if err != nil {
		t.Fatalf("probe capabilities: %v", err)
	}
	if capabilities.WorkflowAvailable || capabilities.Reason != ReasonWorkflowIncomplete {
		t.Fatalf("unexpected capabilities: %+v", capabilities)
	}
	if capabilities.Operations.Archive.Available ||
		capabilities.Operations.ListArchived.Available ||
		capabilities.Operations.Unarchive.Available {
		t.Fatalf("all operations should be unsupported: %+v", capabilities.Operations)
	}
}

func TestListArchivedThreadsRejectsRepeatedCursor(t *testing.T) {
	client, _ := startFakeClient(t, "repeat-cursor")
	_, err := client.ListArchivedThreads(context.Background())
	if !errors.Is(err, ErrCursorRepeated) {
		t.Fatalf("want ErrCursorRepeated, got %v", err)
	}
}

func TestRequestTimeout(t *testing.T) {
	client, _ := startFakeClient(t, "silent")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := client.ListArchivedThreads(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline exceeded, got %v", err)
	}
}

func TestDialFailsWhenProcessExits(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test executable: %v", err)
	}
	client, err := Dial(context.Background(), Config{
		Command: executable,
		Args:    []string{"-test.run=^TestFakeAppServerProcess$"},
		Env: append(os.Environ(),
			fakeMarker+"=1",
			fakeModeEnv+"=exit-immediately",
		),
		RequestTimeout: 2 * time.Second,
	})
	if err == nil {
		_ = client.Close()
		t.Fatal("dial must fail when fake process exits during handshake")
	}
	if !errors.Is(err, ErrTransport) {
		t.Fatalf("want ErrTransport, got %v", err)
	}
}

func TestRequestsAfterCloseFail(t *testing.T) {
	client, _ := startFakeClient(t, "full")
	if err := client.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := client.ArchiveThread(context.Background(), "thread-1"); !errors.Is(err, ErrClosed) {
		t.Fatalf("want ErrClosed, got %v", err)
	}
	if _, err := client.ListArchivedThreads(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("want ErrClosed, got %v", err)
	}
}
