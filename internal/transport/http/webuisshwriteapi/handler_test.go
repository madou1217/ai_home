package webuisshwriteapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	passwordConnectionID = "conn_0123456789abcdef"
	keyConnectionID      = "conn_fedcba9876543210"
	missingConnectionID  = "conn_aaaaaaaaaaaaaaaa"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

type countingStore struct{ calls int }

func (store *countingStore) UpdateConnections(context.Context, func(string, bool) (string, error)) error {
	store.calls++
	return nil
}

func (store *countingStore) DeleteConnectionAndWorkspaces(context.Context, func(KV, KV) (string, string, error)) error {
	store.calls++
	return nil
}

func newTestHandler(t *testing.T) (*Handler, string) {
	t.Helper()
	root := t.TempDir()
	source, err := OpenSource(root)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{Authorizer: allowAll{}, Store: source})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	databasePath, err := appstate.DatabasePath(root)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	return handler, databasePath
}

func doRequest(handler http.Handler, method string, target string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func itemPath(id string) string { return CollectionPath + "/" + id }

func decodeConnection(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload connectionResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK || payload.Connection == nil {
		t.Fatalf("response = %s", recorder.Body.String())
	}
	return payload.Connection
}

func decodeFailure(t *testing.T, recorder *httptest.ResponseRecorder) errorView {
	t.Helper()
	var failure errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &failure); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	return failure
}

func seedConnections(t *testing.T, databasePath string, connections []map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(connections)
	if err != nil {
		t.Fatalf("marshal seed: %v", err)
	}
	if err := appstate.WriteKV(context.Background(), databasePath, connectionsKey, string(encoded), time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed connections: %v", err)
	}
}

func readStoredConnections(t *testing.T, databasePath string) []map[string]any {
	t.Helper()
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, connectionsKey)
	if err != nil {
		t.Fatalf("ReadKV() error = %v", err)
	}
	if !found {
		return nil
	}
	var connections []map[string]any
	if err := json.Unmarshal([]byte(raw), &connections); err != nil {
		t.Fatalf("stored value %q: %v", raw, err)
	}
	return connections
}

func readRawStored(t *testing.T, databasePath string) string {
	t.Helper()
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, connectionsKey)
	if err != nil {
		t.Fatalf("ReadKV() error = %v", err)
	}
	if !found {
		t.Fatalf("ssh_connections missing")
	}
	return raw
}

func TestCreateStoresPlaintextAndMasksResponse(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	recorder := doRequest(handler, http.MethodPost, CollectionPath,
		`{"label":"prod","host":"10.0.0.1","port":2222,"user":"dev","authType":"password","password":"s3cret","privateKey":"ignored"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	connection := decodeConnection(t, recorder)
	id, _ := connection["id"].(string)
	if !connectionIDPattern.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	if connection["password"] != passwordMask {
		t.Fatalf("response password = %#v", connection["password"])
	}
	if connection["privateKey"] != "" {
		t.Fatalf("password 连接的私钥应清空: %#v", connection["privateKey"])
	}
	stored := readStoredConnections(t, databasePath)
	if len(stored) != 1 {
		t.Fatalf("stored = %#v", stored)
	}
	if stored[0]["password"] != "s3cret" {
		t.Fatalf("stored password = %#v", stored[0]["password"])
	}
	if stored[0]["port"] != float64(2222) || stored[0]["user"] != "dev" || stored[0]["host"] != "10.0.0.1" {
		t.Fatalf("stored = %#v", stored[0])
	}
	if _, ok := stored[0]["createdAt"].(float64); !ok {
		t.Fatalf("createdAt = %#v", stored[0]["createdAt"])
	}
}

func TestCreateDefaultsAndMaskSentinelAreNotStored(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	recorder := doRequest(handler, http.MethodPost, CollectionPath,
		`{"label":"box","host":"example.com","user":"dev","password":"******"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	stored := readStoredConnections(t, databasePath)
	if len(stored) != 1 {
		t.Fatalf("stored = %#v", stored)
	}
	if stored[0]["port"] != float64(22) || stored[0]["authType"] != "agent" {
		t.Fatalf("defaults = %#v", stored[0])
	}
	if stored[0]["password"] != "" {
		t.Fatalf("掩码不应落库: %#v", stored[0]["password"])
	}
}

func TestCreateStoresTunnelAndValidEgress(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	first := decodeConnection(t, doRequest(handler, http.MethodPost, CollectionPath,
		`{"label":"first","host":"10.0.0.1","user":"dev"}`))
	firstID, _ := first["id"].(string)
	recorder := doRequest(handler, http.MethodPost, CollectionPath, fmt.Sprintf(
		`{"label":"second","host":"10.0.0.2","user":"dev","egressConnectionId":%q,"reverseTunnel":{"remotePort":22022}}`, firstID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	stored := readStoredConnections(t, databasePath)
	if len(stored) != 2 {
		t.Fatalf("stored = %#v", stored)
	}
	second := stored[1]
	if second["egressConnectionId"] != firstID {
		t.Fatalf("egress = %#v", second["egressConnectionId"])
	}
	tunnel, ok := second["reverseTunnel"].(map[string]any)
	if !ok || tunnel["remotePort"] != float64(22022) || tunnel["localPort"] != float64(22) {
		t.Fatalf("tunnel = %#v", second["reverseTunnel"])
	}
}

func TestCreateRejectsInvalidFields(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	cases := []struct {
		name string
		body string
		code string
	}{
		{"missing label", `{"label":"","host":"h","user":"dev"}`, "missing_fields"},
		{"missing host", `{"label":"l","host":"","user":"dev"}`, "missing_fields"},
		{"missing user", `{"label":"l","host":"h","user":""}`, "missing_fields"},
		{"option injection", `{"label":"l","host":"-oProxyCommand=id","user":"dev"}`, "invalid_host"},
		{"shell char in host", `{"label":"l","host":"h;id","user":"dev"}`, "invalid_host"},
		{"user at sign", `{"label":"l","host":"h","user":"a@b"}`, "invalid_user"},
		{"bad auth type", `{"label":"l","host":"h","user":"dev","authType":"root"}`, "invalid_auth_type"},
		{"bad port", `{"label":"l","host":"h","user":"dev","port":70000}`, "invalid_port"},
		{"unknown egress", `{"label":"l","host":"h","user":"dev","egressConnectionId":"conn_aaaaaaaaaaaaaaaa"}`, "invalid_egress"},
		{"key-file without identity", `{"label":"l","host":"h","user":"dev","authType":"key-file"}`, "invalid_identity_file"},
		{"identity traversal", `{"label":"l","host":"h","user":"dev","authType":"key-file","identityFile":"/home/dev/.ssh/../secret"}`, "invalid_identity_file"},
		{"bad tunnel port", `{"label":"l","host":"h","user":"dev","reverseTunnel":{"remotePort":80}}`, "invalid_reverse_tunnel"},
		{"non-string host", `{"label":"l","host":22,"user":"dev"}`, "invalid_fields"},
		{"json array", `[]`, "invalid_request_body"},
		{"truncated json", `{`, "invalid_json_body"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := doRequest(handler, http.MethodPost, CollectionPath, testCase.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
			}
			if failure := decodeFailure(t, recorder); failure.Error != testCase.code {
				t.Fatalf("error = %q, want %q", failure.Error, testCase.code)
			}
		})
	}
	if stored := readStoredConnections(t, databasePath); len(stored) != 0 {
		t.Fatalf("invalid requests wrote data: %#v", stored)
	}
}

func TestUpdatePreservesOmittedSecretsAndUnknownFields(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{{
		"id": passwordConnectionID, "label": "pw", "host": "10.0.0.2", "port": 22,
		"user": "dev", "authType": "password", "password": "keep-me", "privateKey": "",
		"identityFile": "", "createdAt": 1, "extra": map[string]any{"keep": true},
	}})
	recorder := doRequest(handler, http.MethodPut, itemPath(passwordConnectionID), `{"label":"renamed"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if connection := decodeConnection(t, recorder); connection["password"] != passwordMask {
		t.Fatalf("response password = %#v", connection["password"])
	}
	stored := readStoredConnections(t, databasePath)
	if stored[0]["password"] != "keep-me" {
		t.Fatalf("omitted secret lost: %#v", stored[0]["password"])
	}
	if stored[0]["label"] != "renamed" {
		t.Fatalf("label = %#v", stored[0]["label"])
	}
	extra, ok := stored[0]["extra"].(map[string]any)
	if !ok || extra["keep"] != true {
		t.Fatalf("unknown field lost: %#v", stored[0]["extra"])
	}

	masked := doRequest(handler, http.MethodPut, itemPath(passwordConnectionID), `{"password":"******"}`)
	if masked.Code != http.StatusOK {
		t.Fatalf("mask status = %d body = %s", masked.Code, masked.Body.String())
	}
	if stored := readStoredConnections(t, databasePath); stored[0]["password"] != "keep-me" {
		t.Fatalf("mask overwrote secret: %#v", stored[0]["password"])
	}
}

func TestUpdatePreservesKeyAndClearsInactiveSecretsOnAuthSwitch(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{{
		"id": keyConnectionID, "label": "key", "host": "10.0.0.3", "port": 22,
		"user": "dev", "authType": "key", "password": "", "privateKey": "KEY-MATERIAL",
		"identityFile": "", "createdAt": 1,
	}})
	recorder := doRequest(handler, http.MethodPut, itemPath(keyConnectionID), `{"privateKey":"******"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if stored := readStoredConnections(t, databasePath); stored[0]["privateKey"] != "KEY-MATERIAL" {
		t.Fatalf("mask overwrote key: %#v", stored[0]["privateKey"])
	}

	switched := doRequest(handler, http.MethodPut, itemPath(keyConnectionID), `{"authType":"password","password":"new-pass"}`)
	if switched.Code != http.StatusOK {
		t.Fatalf("switch status = %d body = %s", switched.Code, switched.Body.String())
	}
	stored := readStoredConnections(t, databasePath)
	if stored[0]["password"] != "new-pass" || stored[0]["privateKey"] != "" {
		t.Fatalf("switch did not clear inactive secret: %#v", stored[0])
	}
	if stored[0]["authType"] != "password" {
		t.Fatalf("authType = %#v", stored[0]["authType"])
	}
}

func TestUpdateRejectsInvalidIDMissingConnectionAndEmptyFields(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	invalid := doRequest(handler, http.MethodPut, itemPath("not-a-connection"), `{"label":"x"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d", invalid.Code)
	}
	if failure := decodeFailure(t, invalid); failure.Error != "invalid_connection_id" {
		t.Fatalf("error = %q", failure.Error)
	}
	missing := doRequest(handler, http.MethodPut, itemPath(missingConnectionID), `{"label":"x"}`)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d body = %s", missing.Code, missing.Body.String())
	}
	if failure := decodeFailure(t, missing); failure.Error != "not_found" {
		t.Fatalf("error = %q", failure.Error)
	}

	seedConnections(t, databasePath, []map[string]any{{
		"id": passwordConnectionID, "label": "pw", "host": "10.0.0.2", "port": 22,
		"user": "", "authType": "password", "password": "keep", "createdAt": 1,
	}})
	empty := doRequest(handler, http.MethodPut, itemPath(passwordConnectionID), `{"label":"x"}`)
	if empty.Code != http.StatusBadRequest {
		t.Fatalf("empty user status = %d body = %s", empty.Code, empty.Body.String())
	}
	if stored := readStoredConnections(t, databasePath); stored[0]["label"] != "pw" {
		t.Fatalf("rejected update wrote data: %#v", stored[0])
	}
}

func TestDeleteRemovesConnectionAndClearsEgressReferences(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{
		{"id": passwordConnectionID, "label": "a", "host": "10.0.0.1", "port": 22, "user": "dev", "authType": "agent"},
		{"id": keyConnectionID, "label": "b", "host": "10.0.0.2", "port": 22, "user": "dev", "authType": "agent", "egressConnectionId": passwordConnectionID},
		{"id": missingConnectionID, "label": "c", "host": "10.0.0.3", "port": 22, "user": "dev", "authType": "agent"},
	})
	recorder := doRequest(handler, http.MethodDelete, itemPath(passwordConnectionID), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	stored := readStoredConnections(t, databasePath)
	if len(stored) != 2 {
		t.Fatalf("stored = %#v", stored)
	}
	for _, connection := range stored {
		if connection["id"] == passwordConnectionID {
			t.Fatalf("deleted connection still present")
		}
		if connection["id"] == keyConnectionID && connection["egressConnectionId"] != "" {
			t.Fatalf("dangling egress = %#v", connection["egressConnectionId"])
		}
	}

	repeated := doRequest(handler, http.MethodDelete, itemPath(passwordConnectionID), "")
	if repeated.Code != http.StatusOK {
		t.Fatalf("repeat status = %d body = %s", repeated.Code, repeated.Body.String())
	}
	invalid := doRequest(handler, http.MethodDelete, itemPath("nope"), "")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d", invalid.Code)
	}
}

func TestAuthMethodsAndPathsFailClosed(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	if recorder := doRequest(handler, http.MethodGet, CollectionPath, ""); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d", recorder.Code)
	}
	if recorder := doRequest(handler, http.MethodPost, itemPath(passwordConnectionID), `{}`); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST item status = %d", recorder.Code)
	}
	if recorder := doRequest(handler, http.MethodPatch, CollectionPath, `{}`); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PATCH status = %d", recorder.Code)
	}
	if recorder := doRequest(handler, http.MethodPut, "/v1/management/webui/other", `{}`); recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d", recorder.Code)
	}

	store := &countingStore{}
	denied, err := NewHandler(Dependencies{Authorizer: denyAll{}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	if recorder := doRequest(denied, http.MethodPost, CollectionPath, `{"label":"l","host":"h","user":"dev"}`); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
	if store.calls != 0 {
		t.Fatalf("unauthorized request reached store: %d", store.calls)
	}
	if stored := readStoredConnections(t, databasePath); len(stored) != 0 {
		t.Fatalf("unauthorized request wrote data: %#v", stored)
	}

	var unavailable *Handler
	recorder := httptest.NewRecorder()
	unavailable.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, CollectionPath, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil handler status = %d", recorder.Code)
	}
}

func TestCorruptStoreFailsClosed(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	if err := appstate.WriteKV(context.Background(), databasePath, connectionsKey, `{"not":"array"}`, 1); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	recorder := doRequest(handler, http.MethodPost, CollectionPath, `{"label":"l","host":"h","user":"dev"}`)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if failure := decodeFailure(t, recorder); failure.Error != "ssh_connections_invalid" {
		t.Fatalf("error = %q", failure.Error)
	}
	if raw := readRawStored(t, databasePath); raw != `{"not":"array"}` {
		t.Fatalf("corrupt value was overwritten: %s", raw)
	}
}

func TestConcurrentCreatesDoNotLoseUpdates(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	const workers = 8
	statuses := make(chan int, workers)
	var waitGroup sync.WaitGroup
	for index := 0; index < workers; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			body := fmt.Sprintf(`{"label":"n%d","host":"10.0.1.%d","user":"dev"}`, index, index+1)
			statuses <- doRequest(handler, http.MethodPost, CollectionPath, body).Code
		}(index)
	}
	waitGroup.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent create status = %d", status)
		}
	}
	stored := readStoredConnections(t, databasePath)
	if len(stored) != workers {
		t.Fatalf("lost update: stored %d of %d", len(stored), workers)
	}
	seen := make(map[string]bool, len(stored))
	for _, connection := range stored {
		id, _ := connection["id"].(string)
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}
func TestRoutesMountOnServeMux(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	mux := http.NewServeMux()
	for _, route := range handler.Routes() {
		mux.Handle(route.Pattern, route.Handler)
	}
	created := doRequest(mux, http.MethodPost, CollectionPath, `{"label":"mux","host":"example.com","user":"dev"}`)
	if created.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", created.Code, created.Body.String())
	}
	id, _ := decodeConnection(t, created)["id"].(string)
	updated := doRequest(mux, http.MethodPut, itemPath(id), `{"label":"mux-renamed"}`)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", updated.Code, updated.Body.String())
	}
	deleted := doRequest(mux, http.MethodDelete, itemPath(id), "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d body = %s", deleted.Code, deleted.Body.String())
	}
	if stored := readStoredConnections(t, databasePath); len(stored) != 0 {
		t.Fatalf("stored = %#v", stored)
	}
}
