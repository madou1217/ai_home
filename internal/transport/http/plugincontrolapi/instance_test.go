package plugincontrolapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

type stubOperator struct {
	result    plugincontrol.InstanceResult
	err       error
	calls     int
	operation plugincontrol.Operation
	instance  string
	input     json.RawMessage
	expected  *int64
}

func (operator *stubOperator) Apply(
	_ context.Context,
	operation plugincontrol.Operation,
	instanceID string,
	input json.RawMessage,
	expectedRevision *int64,
) (plugincontrol.InstanceResult, error) {
	operator.calls++
	operator.operation = operation
	operator.instance = instanceID
	operator.input = append(json.RawMessage(nil), input...)
	operator.expected = expectedRevision
	return operator.result, operator.err
}

func newInstanceHandler(t *testing.T, operator InstanceOperator, allowed bool) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: allowed},
		Installer:  &stubInstaller{},
		Operator:   operator,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func performInstance(t *testing.T, handler *Handler, method string, path string, body string) (int, map[string]any) {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	var request *http.Request
	if reader == nil {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, reader)
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("响应不是 JSON: %s (%v)", recorder.Body.String(), err)
		}
	}
	return recorder.Code, payload
}

func TestInstanceEnableUsesPathIDAndExpectedRevision(t *testing.T) {
	operator := &stubOperator{result: plugincontrol.InstanceResult{Revision: 4, Generation: 9, State: "active"}}
	handler := newInstanceHandler(t, operator, true)
	status, payload := performInstance(t, handler, http.MethodPost,
		InstancesPath+"/echo/enable",
		`{"pluginId":"other","acceptPermissions":true,"expectedRevision":3}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %+v", status, payload)
	}
	if payload["ok"] != true || payload["revision"] != float64(4) || payload["generation"] != float64(9) || payload["state"] != "active" {
		t.Fatalf("响应字段不符: %+v", payload)
	}
	if operator.calls != 1 || operator.operation != plugincontrol.OperationEnable || operator.instance != "echo" {
		t.Fatalf("operator 参数 = %+v", operator)
	}
	if operator.expected == nil || *operator.expected != 3 {
		t.Fatalf("expectedRevision = %v", operator.expected)
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(operator.input, &input); err != nil {
		t.Fatalf("input 不是 JSON 对象: %v", err)
	}
	if string(input["instanceId"]) != `"echo"` {
		t.Fatalf("instanceId 未以路径为准: %s", string(input["instanceId"]))
	}
	if string(input["pluginId"]) != `"other"` {
		t.Fatalf("body 其它字段被丢弃: %s", string(input["pluginId"]))
	}
}

func TestInstanceDisableAcceptsEmptyBody(t *testing.T) {
	operator := &stubOperator{result: plugincontrol.InstanceResult{Revision: 5, Generation: 0, State: "idle"}}
	handler := newInstanceHandler(t, operator, true)
	status, payload := performInstance(t, handler, http.MethodPost, InstancesPath+"/echo/disable", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %+v", status, payload)
	}
	if operator.operation != plugincontrol.OperationDisable || operator.instance != "echo" || operator.expected != nil {
		t.Fatalf("operator 参数 = %+v", operator)
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(operator.input, &input); err != nil || string(input["instanceId"]) != `"echo"` {
		t.Fatalf("input = %s err=%v", string(operator.input), err)
	}
}

func TestInstanceConflictReturns409(t *testing.T) {
	operator := &stubOperator{err: &plugincontrol.RevisionConflictError{Current: 7}}
	handler := newInstanceHandler(t, operator, true)
	status, payload := performInstance(t, handler, http.MethodPost, InstancesPath+"/echo/enable", `{"pluginId":"echo"}`)
	if status != http.StatusConflict || payload["error"] != plugincontrol.CodeRevisionConflict {
		t.Fatalf("status = %d body = %+v", status, payload)
	}
	if diagnostics, ok := payload["diagnostics"].([]any); !ok || len(diagnostics) != 0 {
		t.Fatalf("diagnostics 形状不符: %+v", payload["diagnostics"])
	}
}

func TestInstanceCandidateRejectedCarriesDiagnostics(t *testing.T) {
	coded := pluginerr.New(plugincontrol.CodeCandidateRejected, "apply boom")
	coded.Diagnostics = []any{map[string]any{"code": "plugin_apply_failed", "detail": "boom"}}
	operator := &stubOperator{err: coded}
	handler := newInstanceHandler(t, operator, true)
	status, payload := performInstance(t, handler, http.MethodPost, InstancesPath+"/echo/enable", `{"pluginId":"echo"}`)
	if status != http.StatusBadRequest || payload["error"] != plugincontrol.CodeCandidateRejected {
		t.Fatalf("status = %d body = %+v", status, payload)
	}
	diagnostics := payload["diagnostics"].([]any)
	if diagnostics[0].(map[string]any)["code"] != "plugin_apply_failed" {
		t.Fatalf("diagnostics = %+v", diagnostics)
	}
}

func TestInstanceUnauthorizedAndMethod(t *testing.T) {
	operator := &stubOperator{}
	handler := newInstanceHandler(t, operator, false)
	status, _ := performInstance(t, handler, http.MethodPost, InstancesPath+"/echo/enable", `{}`)
	if status != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", status)
	}
	allowed := newInstanceHandler(t, operator, true)
	status, _ = performInstance(t, allowed, http.MethodGet, InstancesPath+"/echo/enable", "")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", status)
	}
	status, _ = performInstance(t, allowed, http.MethodPost, InstancesPath+"/echo/explode", `{}`)
	if status != http.StatusNotFound {
		t.Fatalf("unknown operation status = %d", status)
	}
	if operator.calls != 0 {
		t.Fatalf("operator calls = %d", operator.calls)
	}
}
