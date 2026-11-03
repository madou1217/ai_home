package modelsapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelcatalog"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

type projectionCatalogReader struct {
	snapshot modelcatalog.Snapshot
}

func testProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

func (reader projectionCatalogReader) Snapshot() modelcatalog.Snapshot { return reader.snapshot }

func TestModelListUsesProjectedGlobalCatalogWhenAvailable(t *testing.T) {
	providerCatalog := testProviderCatalog(t)
	localModel, err := accountapp.NewRoutableModel(providerCatalog, "codex", "local-model")
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	projection := modelcatalog.Snapshot{
		Generation: 1,
		Revision:   "rev-global",
		Items: []modelcatalog.Item{
			{
				ID: "node-only", OwnedBy: "opencode",
				InputModalities: []string{"text", "image"}, OutputModalities: []string{"text"},
				ReasoningEfforts: []inference.ReasoningEffort{inference.ReasoningEffortHigh},
			},
		},
	}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{models: []accountapp.RoutableModel{localModel}},
		Modalities: staticMetadataReader{},
		Reasoning:  nil,
		Aliases:    nil,
		Catalog:    projectionCatalogReader{snapshot: projection},
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Data []struct {
			ID         string `json:"id"`
			OwnedBy    string `json:"owned_by"`
			Modalities struct {
				Input  []string `json:"input"`
				Output []string `json:"output"`
			} `json:"aih_modalities"`
			Efforts []string `json:"aih_reasoning_efforts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 1 || body.Data[0].ID != "node-only" || body.Data[0].OwnedBy != "opencode" {
		t.Fatalf("projected data = %#v", body.Data)
	}
	if len(body.Data[0].Modalities.Input) != 2 || body.Data[0].Modalities.Input[1] != "image" {
		t.Fatalf("projected modalities = %#v", body.Data[0].Modalities)
	}
	if len(body.Data[0].Efforts) != 1 || body.Data[0].Efforts[0] != "high" {
		t.Fatalf("projected efforts = %#v", body.Data[0].Efforts)
	}
}

func TestModelListCapabilityFilterUsesProjectedModalities(t *testing.T) {
	projection := modelcatalog.Snapshot{
		Generation: 1,
		Revision:   "rev-vision",
		Items: []modelcatalog.Item{
			{ID: "node-vision", OwnedBy: "opencode", InputModalities: []string{"text", "image"}, OutputModalities: []string{"text"}},
			{ID: "node-text", OwnedBy: "opencode", InputModalities: []string{"text"}, OutputModalities: []string{"text"}},
		},
	}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{},
		Modalities: staticMetadataReader{},
		Catalog:    projectionCatalogReader{snapshot: projection},
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path+"?capability=vision", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 1 || body.Data[0].ID != "node-vision" {
		t.Fatalf("vision data = %#v", body.Data)
	}
}

func TestModelListFallsBackToLocalReaderWithoutProjection(t *testing.T) {
	providerCatalog := testProviderCatalog(t)
	localModel, err := accountapp.NewRoutableModel(providerCatalog, "codex", "local-model")
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{models: []accountapp.RoutableModel{localModel}},
		Modalities: staticMetadataReader{},
		Catalog:    projectionCatalogReader{snapshot: modelcatalog.Snapshot{}},
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 1 || body.Data[0].ID != "local-model" {
		t.Fatalf("local fallback data = %#v", body.Data)
	}
}

var _ modelmetadata.Reader = staticMetadataReader{}
