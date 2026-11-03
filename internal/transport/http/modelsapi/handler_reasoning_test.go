package modelsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

type reasoningModelReader struct {
	models []accountapp.RoutableModel
}

func (r reasoningModelReader) ListRoutableModels(context.Context) ([]accountapp.RoutableModel, error) {
	return r.models, nil
}

type reasoningMetadataReader struct {
	modelmetadata.Reader
	ladder []inference.ReasoningEffort
}

func (r reasoningMetadataReader) LookupReasoningEfforts(string, string) ([]inference.ReasoningEffort, bool) {
	return append([]inference.ReasoningEffort(nil), r.ladder...), true
}

type reasoningAuthorizer struct{}

func (reasoningAuthorizer) Authorized(*http.Request) bool { return true }

type displayAliasReader struct{}

func (displayAliasReader) ListDisplayModels() []modelalias.DisplayModel {
	return []modelalias.DisplayModel{{Alias: "aaa-model", Target: "gpt-6.1-sol", Provider: "codex"}}
}

type duplicateDisplayAliasReader struct{}

func (duplicateDisplayAliasReader) ListDisplayModels() []modelalias.DisplayModel {
	return []modelalias.DisplayModel{
		{Alias: "duplicate-model", Target: "gpt-6.1-sol", Provider: "codex"},
		{Alias: "duplicate-model", Target: "gpt-6.1-sol", Provider: "codex"},
	}
}

func TestModelListIncludesReasoningEffortsFromMetadataReader(t *testing.T) {
	manifest := providers.BuiltinManifest()
	catalog, err := providers.NewCatalog(manifest)
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	model, err := accountapp.NewRoutableModel(catalog, "codex", "gpt-6.1-sol")
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	modalities := reasoningMetadataReader{
		Reader: staticMetadataReader{},
		ladder: []inference.ReasoningEffort{inference.ReasoningEffortLow, inference.ReasoningEffortHigh},
	}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{models: []accountapp.RoutableModel{model}},
		Modalities: modalities,
		Reasoning:  modalities,
		Aliases:    nil,
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body struct {
		Data []struct {
			Efforts []string `json:"aih_reasoning_efforts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 1 || len(body.Data[0].Efforts) != 2 || body.Data[0].Efforts[0] != "low" || body.Data[0].Efforts[1] != "high" {
		t.Fatalf("reasoning efforts = %#v, want [low high]", body.Data)
	}
}

func TestModelListIncludesCompiledAliasDisplayModel(t *testing.T) {
	catalog := providers.BuiltinManifest()
	providerCatalog, err := providers.NewCatalog(catalog)
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	model, err := accountapp.NewRoutableModel(providerCatalog, "codex", "gpt-6.1-sol")
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	modalities := reasoningMetadataReader{Reader: staticMetadataReader{}}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{models: []accountapp.RoutableModel{model}},
		Modalities: modalities,
		Aliases:    displayAliasReader{},
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 2 || body.Data[0].ID != "aaa-model" || body.Data[1].ID != "gpt-6.1-sol" {
		t.Fatalf("models = %#v, want native plus compiled alias", body.Data)
	}
}

func TestModelListDeduplicatesCompiledAliasIDs(t *testing.T) {
	catalog := providers.BuiltinManifest()
	providerCatalog, err := providers.NewCatalog(catalog)
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	model, err := accountapp.NewRoutableModel(providerCatalog, "codex", "gpt-6.1-sol")
	if err != nil {
		t.Fatalf("NewRoutableModel() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Models:     reasoningModelReader{models: []accountapp.RoutableModel{model}},
		Modalities: staticMetadataReader{},
		Aliases:    duplicateDisplayAliasReader{},
		Authorizer: reasoningAuthorizer{},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, Path, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 2 {
		t.Fatalf("models = %#v, want one native and one alias model", body.Data)
	}
}

type staticMetadataReader struct{}

func (staticMetadataReader) LookupModalities(string, string) (modelmetadata.Modalities, bool) {
	return modelmetadata.TextOnly(), true
}
func (staticMetadataReader) LookupOrInferModalities(string, string) (modelmetadata.Modalities, bool) {
	return modelmetadata.TextOnly(), true
}
