package webuimodelcontextapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func postJSON(t *testing.T, handler http.Handler, path string, payload any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body)))
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func TestSingleWriteSetAndClear(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})
	path := Path + "/codex/" + mainRef + "/model-context"

	recorder, payload := postJSON(t, handler, path, map[string]any{"model": "gpt-5", "tokens": 50000})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	overrides := payload["overrides"].(map[string]any)
	if overrides[mainRef].(map[string]any)["gpt-5"] != float64(50000) {
		t.Fatalf("overrides = %#v", overrides)
	}
	resolved := payload["resolved"].(map[string]any)
	if resolved["tokens"] != float64(50000) || resolved["source"] != "override" {
		t.Fatalf("resolved = %#v", resolved)
	}

	_, fetched := requestModelContext(t, handler, "codex", mainRef, "?models=gpt-5")
	row := fetched["models"].([]any)[0].(map[string]any)
	if row["tokens"] != float64(50000) || row["override"] != float64(50000) {
		t.Fatalf("fetched = %#v", row)
	}

	recorder, cleared := postJSON(t, handler, path, map[string]any{"model": "gpt-5", "tokens": nil})
	if recorder.Code != http.StatusOK {
		t.Fatalf("clear status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	overrides = cleared["overrides"].(map[string]any)
	if _, exists := overrides[mainRef]; exists {
		t.Fatalf("override not cleared: %#v", overrides)
	}
	resolved = cleared["resolved"].(map[string]any)
	if resolved["tokens"] != float64(0) || resolved["source"] != "unknown" {
		t.Fatalf("cleared resolved = %#v", resolved)
	}
}

func TestBulkWriteAppliesAllAccounts(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})

	recorder, payload := postJSON(t, handler, Path+"/codex/model-context/bulk", map[string]any{
		"model": "gpt-5", "tokens": 70000, "accountRefs": []string{mainRef, oauthRef, mainRef, " "},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	overrides := payload["overrides"].(map[string]any)
	for _, ref := range []string{mainRef, oauthRef} {
		if overrides[ref].(map[string]any)["gpt-5"] != float64(70000) {
			t.Fatalf("%s = %#v", ref, overrides[ref])
		}
	}
	if len(overrides) != 2 {
		t.Fatalf("overrides = %#v", overrides)
	}
}

func TestWriteValidation(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})
	path := Path + "/codex/" + mainRef + "/model-context"

	cases := []struct {
		name    string
		payload any
		status  int
		code    string
	}{
		{name: "token below minimum", payload: map[string]any{"model": "gpt-5", "tokens": 12}, status: 400, code: "context_tokens_out_of_range"},
		{name: "token fraction", payload: map[string]any{"model": "gpt-5", "tokens": 1024.5}, status: 400, code: "context_tokens_out_of_range"},
		{name: "missing model", payload: map[string]any{"tokens": 2048}, status: 400, code: "account_and_model_required"},
		{name: "empty body", payload: map[string]any{}, status: 400, code: "account_and_model_required"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder, payload := postJSON(t, handler, path, testCase.payload)
			if recorder.Code != testCase.status || payload["error"] != testCase.code {
				t.Fatalf("status=%d payload=%#v", recorder.Code, payload)
			}
		})
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte("{"))))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid json status = %d", recorder.Code)
	}

	recorder, _ = postJSON(t, handler, Path+"/codex/acct_ffffffffffffffffffff/model-context", map[string]any{"model": "gpt-5", "tokens": 2048})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown account status = %d", recorder.Code)
	}
	recorder, _ = postJSON(t, handler, Path+"/claude/"+mainRef+"/model-context", map[string]any{"model": "gpt-5", "tokens": 2048})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d", recorder.Code)
	}
}

func TestDeleteClearsOverride(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})
	base := Path + "/codex/" + mainRef + "/model-context"

	recorder, _ := postJSON(t, handler, base, map[string]any{"model": "gpt-5", "tokens": 50000})
	if recorder.Code != http.StatusOK {
		t.Fatalf("set status = %d body = %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, base+"?model=gpt-5", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	overrides := payload["overrides"].(map[string]any)
	if _, exists := overrides[mainRef]; exists {
		t.Fatalf("override not cleared: %#v", overrides)
	}
	resolved := payload["resolved"].(map[string]any)
	if resolved["tokens"] != float64(0) || resolved["source"] != "unknown" {
		t.Fatalf("resolved = %#v", resolved)
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodDelete, base, nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing model status = %d", recorder.Code)
	}
}
