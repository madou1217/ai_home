package webuichatapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func newFullRunsHTTPMux(handler *Handler) *http.ServeMux {
	mux := newCanonicalHTTPMux(handler)
	mux.HandleFunc("GET "+ManagementRunsCollectionPath, handler.ServeRunsCollection)
	mux.HandleFunc("POST "+ManagementRunsPrefixPath+"{runId}/input", handler.ServeRunSubpath)
	mux.HandleFunc("POST "+ManagementRunsPrefixPath+"{runId}/resize", handler.ServeRunSubpath)
	mux.HandleFunc("POST "+ManagementRunsPrefixPath+"{runId}/abort", handler.ServeRunSubpath)
	mux.HandleFunc("POST "+ManagementRunsPrefixPath+"{runId}/approvals/{approvalId}", handler.ServeRunSubpath)
	mux.HandleFunc("POST "+ManagementInternalApprovalPath, handler.ServeApprovalRequest)
	mux.HandleFunc("POST "+ManagementCLIInstallConfirmationsPrefixPath+"{confirmationId}", handler.ServeCliInstallConfirmation)
	mux.HandleFunc("POST "+ManagementLegacyChatPath, handler.ServeLegacyChat)
	return mux
}

func TestRunsRoutesAuthAndUnavailable(t *testing.T) {
	unauthHandler, err := NewHandler(Dependencies{
		Authorizer:  denyAllAuthorizer{},
		PathPrefix:  ManagementCollectionPath,
		Accounts:    &testAccounts{refs: []accountcore.AccountRef{accountA}},
		Credentials: &testCredentials{provider: "opencode"},
		Provider:    &testProvider{BaseProvider: relaycore.NewBaseProvider("opencode", "https://upstream.test"), accessToken: "t"},
		Client:      &testClient{respond: func(_ *http.Request) (*http.Response, error) { return sseBodyResponse("data: [DONE]\n\n"), nil }},
		Attempts:    &testAttempts{},
		Usage:       &testUsage{},
		Clock:       time.Now,
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	unauthMux := newFullRunsHTTPMux(unauthHandler)

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, ManagementRunsCollectionPath},
		{http.MethodPost, ManagementRunsPrefixPath + "run-1/input"},
		{http.MethodPost, ManagementRunsPrefixPath + "run-1/resize"},
		{http.MethodPost, ManagementRunsPrefixPath + "run-1/abort"},
		{http.MethodPost, ManagementRunsPrefixPath + "run-1/approvals/ap-1"},
		{http.MethodPost, ManagementInternalApprovalPath},
		{http.MethodPost, ManagementCLIInstallConfirmationsPrefixPath + "c-1"},
		{http.MethodPost, ManagementLegacyChatPath},
	}
	for _, tc := range cases {
		rec := doJSONRequest(t, unauthMux, tc.method, tc.path, map[string]any{}, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s expected 401, got %d body=%s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}

	noRtHandler, err := NewHandler(Dependencies{
		Authorizer:  allowAllAuthorizer{},
		PathPrefix:  ManagementCollectionPath,
		Accounts:    &testAccounts{refs: []accountcore.AccountRef{accountA}},
		Credentials: &testCredentials{provider: "opencode"},
		Provider:    &testProvider{BaseProvider: relaycore.NewBaseProvider("opencode", "https://upstream.test"), accessToken: "t"},
		Client:      &testClient{respond: func(_ *http.Request) (*http.Response, error) { return sseBodyResponse("data: [DONE]\n\n"), nil }},
		Attempts:    &testAttempts{},
		Usage:       &testUsage{},
		Clock:       time.Now,
	})
	if err != nil {
		t.Fatalf("NewHandler noRt: %v", err)
	}
	noRtMux := newFullRunsHTTPMux(noRtHandler)
	for _, tc := range cases[:7] {
		rec := doJSONRequest(t, noRtMux, tc.method, tc.path, map[string]any{}, nil)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s expected 503, got %d body=%s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestRunsRoutesListInputSteerResizeAndAbort(t *testing.T) {
	handler, svc, _, _ := newCanonicalRuntimeTestRig(t, 15*time.Second)
	mux := newFullRunsHTTPMux(handler)

	var mu sync.Mutex
	var inputs, steers []string
	var cols, rows int
	aborted := false

	svc.RegisterActiveRun(chatruntime.ActiveRunRegistration{
		RunID:           "run-http-1",
		Provider:        "claude",
		AccountRef:      "acct-a",
		SessionID:       "sess-a",
		ProjectDirName:  "dir-a",
		ProjectPath:     "/tmp/dir-a",
		StartedAt:       1000,
		InteractionMode: "confirm",
		WriteInput: func(input string, appendNewline bool) error {
			mu.Lock()
			defer mu.Unlock()
			if appendNewline {
				inputs = append(inputs, input+"\r")
			} else {
				inputs = append(inputs, input)
			}
			return nil
		},
		WriteSteer: func(content string) error {
			mu.Lock()
			defer mu.Unlock()
			steers = append(steers, content)
			return nil
		},
		Resize: func(c, r int) error {
			mu.Lock()
			defer mu.Unlock()
			cols, rows = c, r
			return nil
		},
		Abort: func() error {
			mu.Lock()
			aborted = true
			mu.Unlock()
			return nil
		},
		GetContentSnapshot: func() string { return "snap-1" },
	})

	listRec := doJSONRequest(t, mux, http.MethodGet, ManagementRunsCollectionPath+"?provider=claude&projectDirName=dir-a", nil, nil)
	if listRec.Code != http.StatusOK {
		t.Fatalf("GET runs expected 200, got %d body=%s", listRec.Code, listRec.Body.String())
	}
	runs, _ := decodeJSONBody(t, listRec)["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("expected 1 run, got %v", runs)
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/input", map[string]any{"input": "hello"}, nil).Code != http.StatusOK {
		t.Fatal("input failed")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/input", map[string]any{"input": "x", "appendNewline": false}, nil).Code != http.StatusOK {
		t.Fatal("raw input failed")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/input", map[string]any{"input": "keep going", "mode": "steer"}, nil).Code != http.StatusOK {
		t.Fatal("steer failed")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/input", map[string]any{"input": ""}, nil).Code != http.StatusBadRequest {
		t.Fatal("empty input should be 400")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-nope/input", map[string]any{"input": "hi"}, nil).Code != http.StatusNotFound {
		t.Fatal("missing input should be 404")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-nope/resize", map[string]any{"cols": "invalid"}, nil).Code != http.StatusNotFound {
		t.Fatal("missing resize should be 404")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/resize", map[string]any{"cols": "bad", "rows": 24}, nil).Code != http.StatusBadRequest {
		t.Fatal("invalid resize should be 400")
	}
	resizeOK := doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/resize", map[string]any{"cols": 999, "rows": 2}, nil)
	resBody := decodeJSONBody(t, resizeOK)
	if resizeOK.Code != http.StatusOK || resBody["cols"] != float64(400) || resBody["rows"] != float64(4) {
		t.Fatalf("expected 200 clamped 400x4, got %d %+v", resizeOK.Code, resBody)
	}
	mu.Lock()
	if len(inputs) != 2 || inputs[0] != "hello\r" || inputs[1] != "x" || len(steers) != 1 || steers[0] != "keep going" || cols != 400 || rows != 4 {
		mu.Unlock()
		t.Fatalf("unexpected callbacks: inputs=%v steers=%v cols=%d rows=%d", inputs, steers, cols, rows)
	}
	mu.Unlock()

	ab1 := doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/abort", nil, nil)
	b1 := decodeJSONBody(t, ab1)
	if ab1.Code != http.StatusOK || b1["alreadyGone"] != nil || !aborted {
		t.Fatalf("unexpected first abort: %d %+v aborted=%v", ab1.Code, b1, aborted)
	}
	ab2 := doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-http-1/abort", nil, nil)
	b2 := decodeJSONBody(t, ab2)
	if ab2.Code != http.StatusOK || b2["alreadyGone"] != true {
		t.Fatalf("expected alreadyGone=true, got %d %+v", ab2.Code, b2)
	}
}

func TestRunsRoutesApprovalLongPollCanonicalAndDisconnect(t *testing.T) {
	handler, svc, _, _ := newCanonicalRuntimeTestRig(t, 15*time.Second)
	mux := newFullRunsHTTPMux(handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx := context.Background()
	sess, err := svc.CreateSession(ctx, chatruntime.CreateSessionInput{
		Provider:            "claude",
		ExecutionAccountRef: "acct-a",
		ProjectPath:         t.TempDir(),
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	surface := chatruntime.NewNativeApprovalSurface(svc.Store(), sess.SessionID, "claude", "acct-a")
	t.Cleanup(surface.Dispose)
	svc.RegisterApprovalSurface(sess.SessionID, surface)
	svc.BindApprovalSurfaceRun("run-srv-1", surface)

	evCh := make(chan chatruntime.EventEnvelope, 16)
	unsub, err := svc.EventHub().Subscribe(sess.SessionID, func(ev chatruntime.EventEnvelope) {
		evCh <- ev
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer unsub()

	type httpResp struct {
		status int
		body   map[string]any
		err    error
	}
	lpCh := make(chan httpResp, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{
			"runId":     "run-srv-1",
			"toolName":  "Bash",
			"input":     map[string]any{"command": "pwd"},
			"toolUseId": "tu-srv-1",
		})
		resp, rerr := http.Post(srv.URL+ManagementInternalApprovalPath, "application/json", bytes.NewReader(raw))
		if rerr != nil {
			lpCh <- httpResp{err: rerr}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var parsed map[string]any
		_ = json.Unmarshal(b, &parsed)
		lpCh <- httpResp{status: resp.StatusCode, body: parsed}
	}()

	var interactionID string
	deadline := time.After(3 * time.Second)
	for interactionID == "" {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.requested" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil {
					if id, ok := inter["interactionId"].(string); ok {
						interactionID = id
					}
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for interaction.requested")
		}
	}

	decRec := doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-srv-1/approvals/"+interactionID, map[string]any{"decision": "allow"}, nil)
	if decRec.Code != http.StatusOK || decodeJSONBody(t, decRec)["decision"] != "allow" {
		t.Fatalf("approval decide failed: %d %s", decRec.Code, decRec.Body.String())
	}
	lpRes := <-lpCh
	if lpRes.err != nil || lpRes.status != http.StatusOK || lpRes.body["behavior"] != "allow" {
		t.Fatalf("unexpected long-poll response: %+v", lpRes)
	}

	// 客户端主动取消 HTTP 请求 -> 服务端自动过期交互并广播 interaction.expired
	discCtx, cancelDisc := context.WithCancel(ctx)
	raw2, _ := json.Marshal(map[string]any{"runId": "run-srv-1", "toolName": "Write", "input": map[string]any{"path": "/tmp/z"}})
	req2, err := http.NewRequestWithContext(discCtx, http.MethodPost, srv.URL+ManagementInternalApprovalPath, bytes.NewReader(raw2))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req2.Header.Set("Content-Type", "application/json")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("Do long-poll 2: %v", err)
	}

	var inter2ID string
	deadline2 := time.After(3 * time.Second)
	for inter2ID == "" {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.requested" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil {
					if id, ok := inter["interactionId"].(string); ok {
						inter2ID = id
					}
				}
			}
		case <-deadline2:
			t.Fatal("timed out waiting for second interaction.requested")
		}
	}
	cancelDisc()
	_ = resp2.Body.Close()

	expired := false
	deadline3 := time.After(3 * time.Second)
	for !expired {
		select {
		case ev := <-evCh:
			if ev.Type == "interaction.expired" {
				if inter, _ := ev.Payload["interaction"].(map[string]any); inter != nil {
					if id, ok := inter["interactionId"].(string); ok && id == inter2ID {
						expired = true
					}
				}
			}
		case <-deadline3:
			t.Fatal("timed out waiting for interaction.expired on HTTP disconnect")
		}
	}

	// 独立审批长挂与已解决幂等
	lpExtCh := make(chan httpResp, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{"runId": "run-ext-http", "toolName": "Edit"})
		resp, rerr := http.Post(srv.URL+ManagementInternalApprovalPath, "application/json", bytes.NewReader(raw))
		if rerr != nil {
			lpExtCh <- httpResp{err: rerr}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var parsed map[string]any
		_ = json.Unmarshal(b, &parsed)
		lpExtCh <- httpResp{status: resp.StatusCode, body: parsed}
	}()
	svc.RegisterActiveRun(chatruntime.ActiveRunRegistration{RunID: "run-ext-http", Provider: "claude"})
	var extID string
	for i := 0; i < 40 && extID == ""; i++ {
		runs, _ := svc.ListActiveRuns(ctx, chatruntime.ListActiveRunsFilter{})
		for _, r := range runs {
			if r.RunID == "run-ext-http" && r.ActivePrompt != nil {
				if id, ok := r.ActivePrompt["promptId"].(string); ok {
					extID = id
				}
			}
		}
		if extID == "" {
			time.Sleep(15 * time.Millisecond)
		}
	}
	if extID == "" {
		t.Fatal("expected external pending approval in activePrompt")
	}
	if doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-ext-http/approvals/"+extID, map[string]any{"decision": "deny", "message": "拒绝写操作"}, nil).Code != http.StatusOK {
		t.Fatal("deny failed")
	}
	extRes := <-lpExtCh
	if extRes.err != nil || extRes.status != http.StatusOK || extRes.body["behavior"] != "deny" || extRes.body["message"] != "拒绝写操作" {
		t.Fatalf("unexpected ext approval long-poll: %+v", extRes)
	}
	dupRec := doJSONRequest(t, mux, http.MethodPost, ManagementRunsPrefixPath+"run-ext-http/approvals/"+extID, map[string]any{"decision": "allow"}, nil)
	if decodeJSONBody(t, dupRec)["alreadyResolved"] != true {
		t.Fatalf("expected alreadyResolved=true, got %s", dupRec.Body.String())
	}
}

func TestRunsRoutesCLIInstallConfirmationAndLegacyChat(t *testing.T) {
	handler, svc, _, _ := newCanonicalRuntimeTestRig(t, 15*time.Second)
	mux := newFullRunsHTTPMux(handler)

	if rec := doJSONRequest(t, mux, http.MethodPost, ManagementCLIInstallConfirmationsPrefixPath+"c-1", map[string]any{"decision": "maybe"}, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if rec := doJSONRequest(t, mux, http.MethodPost, ManagementCLIInstallConfirmationsPrefixPath+"c-missing", map[string]any{"decision": "confirm"}, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}

	ticket := svc.CLIInstallConfirmations().Create("claude", 2*time.Second)
	okRec := doJSONRequest(t, mux, http.MethodPost, ManagementCLIInstallConfirmationsPrefixPath+ticket.ConfirmationID, map[string]any{"decision": "confirm"}, nil)
	if okRec.Code != http.StatusOK || decodeJSONBody(t, okRec)["decision"] != "confirm" {
		t.Fatalf("expected 200 confirm, got %d %s", okRec.Code, okRec.Body.String())
	}
	waited, err := ticket.Wait(context.Background())
	if err != nil || waited.Decision != "confirm" {
		t.Fatalf("unexpected ticket wait: %+v err=%v", waited, err)
	}

	if rec := doJSONRequest(t, mux, http.MethodPost, ManagementLegacyChatPath, "not-json", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if rec := doJSONRequest(t, mux, http.MethodPost, ManagementLegacyChatPath, map[string]any{"prompt": "hi"}, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	mig := doJSONRequest(t, mux, http.MethodPost, ManagementLegacyChatPath, map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}, nil)
	migBody := decodeJSONBody(t, mig)
	if mig.Code != http.StatusConflict || migBody["error"] != "chat_harness_required" || migBody["endpoint"] != "/v0/webui/chat/sessions" || !strings.Contains(mig.Body.String(), "Harness") {
		t.Fatalf("unexpected 409 body: %d %s", mig.Code, mig.Body.String())
	}
}
