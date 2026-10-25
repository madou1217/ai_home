package modelcatalogapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/core/providers"
)

type testAuthorizer bool

func (a testAuthorizer) Authorized(*http.Request) bool { return bool(a) }

type testRoutableReader struct {
	models []accountapp.RoutableModel
	err    error
}

func (r testRoutableReader) ListRoutableModels(context.Context) ([]accountapp.RoutableModel, error) {
	return r.models, r.err
}

func testRoutableModel(t *testing.T, provider, id string) accountapp.RoutableModel {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	model, err := accountapp.NewRoutableModel(catalog, provider, id)
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	return model
}

func testHandler(t *testing.T, authorized bool, routable testRoutableReader) (*Handler, *modelcatalog.Store) {
	t.Helper()
	store, err := modelcatalog.NewStore()
	if err != nil {
		t.Fatalf("modelcatalog.NewStore() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: testAuthorizer(authorized),
		Store:      store,
		Routable:   routable,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, store
}

func TestPutRejectsUnauthorizedProjection(t *testing.T) {
	handler, _ := testHandler(t, false, testRoutableReader{})
	req := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(`{"revision":"rev-1","models":[]}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestPutRejectsMalformedProjectionAndPreservesSnapshot(t *testing.T) {
	handler, store := testHandler(t, true, testRoutableReader{})
	if _, err := store.Replace("old", []modelcatalog.Item{{
		ID: "kept", OwnedBy: "openai", InputModalities: []string{"text"}, OutputModalities: []string{"text"},
	}}); err != nil {
		t.Fatalf("seed Replace() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(`{"revision":"bad","models":[{"id":"x","owned_by":"openai","input_modalities":["text"],"output_modalities":["text"],"unknown":true}]}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if got := store.Snapshot(); got.Revision != "old" || len(got.Items) != 1 || got.Items[0].ID != "kept" {
		t.Fatalf("snapshot changed after malformed projection: %#v", got)
	}
}

func TestPutReturnsGenerationAndRoutableIDs(t *testing.T) {
	routable := testRoutableReader{models: []accountapp.RoutableModel{
		testRoutableModel(t, "codex", "gpt-6.1-sol"),
	}}
	handler, store := testHandler(t, true, routable)
	payload := `{"revision":"rev-1","models":[{"id":"gpt-6.1-sol","owned_by":"openai","input_modalities":["text"],"output_modalities":["text"],"reasoning_efforts":["low"]},{"id":"node-only","owned_by":"opencode","input_modalities":["text","image"],"output_modalities":["text"],"reasoning_efforts":[]}]}`
	req := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(payload))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Data struct {
			Generation       int64    `json:"generation"`
			Revision         string   `json:"revision"`
			AcceptedCount    int      `json:"accepted_count"`
			RoutableModelIDs []string `json:"routable_model_ids"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.Generation != 1 || body.Data.Revision != "rev-1" || body.Data.AcceptedCount != 2 {
		t.Fatalf("response data = %#v", body.Data)
	}
	if len(body.Data.RoutableModelIDs) != 1 || body.Data.RoutableModelIDs[0] != "gpt-6.1-sol" {
		t.Fatalf("routable IDs = %#v", body.Data.RoutableModelIDs)
	}
	if got := store.Snapshot(); len(got.Items) != 2 {
		t.Fatalf("stored items = %#v", got.Items)
	}
}

func TestGetReturnsProjectionAndRoutableIDs(t *testing.T) {
	routable := testRoutableReader{models: []accountapp.RoutableModel{
		testRoutableModel(t, "codex", "gpt-6.1-sol"),
	}}
	handler, store := testHandler(t, true, routable)
	if _, err := store.Replace("rev-get", []modelcatalog.Item{{
		ID: "node-only", OwnedBy: "opencode", InputModalities: []string{"text"}, OutputModalities: []string{"text"},
	}}); err != nil {
		t.Fatalf("seed Replace() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body struct {
		Data struct {
			Revision         string   `json:"revision"`
			AcceptedCount    int      `json:"accepted_count"`
			RoutableModelIDs []string `json:"routable_model_ids"`
			Models           []struct {
				ID string `json:"id"`
			} `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.Revision != "rev-get" || body.Data.AcceptedCount != 1 || len(body.Data.Models) != 1 || body.Data.Models[0].ID != "node-only" {
		t.Fatalf("projection view = %#v", body.Data)
	}
	if len(body.Data.RoutableModelIDs) != 1 || body.Data.RoutableModelIDs[0] != "gpt-6.1-sol" {
		t.Fatalf("routable IDs = %#v", body.Data.RoutableModelIDs)
	}
}

func TestPutReturnsUnavailableWhenRoutableReaderFails(t *testing.T) {
	handler, store := testHandler(t, true, testRoutableReader{err: context.Canceled})
	req := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(`{"revision":"rev-1","models":[]}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	if got := store.Snapshot(); got.Generation != 0 {
		t.Fatalf("store changed despite routable reader failure: %#v", got)
	}
}
