package codeassist

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestModelCatalogSourceDiscoversTopLevelAndTieredModelIDs(t *testing.T) {
	t.Parallel()

	client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
		if strings.Contains(request.URL.String(), ":loadCodeAssist") {
			return jsonResponse(http.StatusOK, `{"cloudaicompanionProject":"project-123"}`), nil
		}
		if !strings.Contains(request.URL.String(), ":fetchAvailableModels") {
			t.Fatalf("unexpected URL %s", request.URL)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body: io.NopCloser(strings.NewReader(`{
				"defaultAgentModelId": "claude-opus-4-6-thinking",
				"commandModelIds": ["claude-opus-4-6-thinking"],
				"tabModelIds": [],
				"imageGenerationModelIds": [],
				"mqueryModelIds": [],
				"webSearchModelIds": [],
				"commitMessageModelIds": [],
				"audioTranscriptionModelIds": [],
				"experimentIds": [],
				"tieredModelIds": {},
				"models": {
					"claude-opus-4-6-thinking": {
						"model": "claude-opus-4-6-thinking",
						"apiProvider": "anthropic",
						"modelProvider": "agy",
						"maxOutputTokens": 64000,
						"supportsThinking": true,
						"requiresNoXmlToolExamples": true,
						"supportedMimeTypes": {}
					},
					"gemini-3.5-flash": {"tieredModelIds": {"low": "gemini-3.5-flash-low", "high": "gemini-3.5-flash-high"}},
					"chat_internal": {},
					"MODEL_INTERNAL_ENUM": {},
					"proactive-observer-preview": {}
				}
			}`)),
		}, nil
	}}
	source, err := NewModelCatalogSource(client)
	if err != nil {
		t.Fatalf("NewModelCatalogSource() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), testAgyAuth(t))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	want := []string{"claude-opus-4-6-thinking", "gemini-3.5-flash", "gemini-3.5-flash-high", "gemini-3.5-flash-low"}
	if strings.Join(models, "\n") != strings.Join(want, "\n") {
		t.Fatalf("models = %v, want %v", models, want)
	}
}

func TestDecodeModelIDsRejectsAmbiguousCatalogShapes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		payload string
	}{
		{name: "duplicate models", payload: `{"models":{"m":{}},"models":{"n":{}}}`},
		{name: "non object model detail", payload: `{"models":{"model-m":true}}`},
		{name: "duplicate tiered ids", payload: `{"models":{"m":{"tieredModelIds":{"a":{}},"tieredModelIds":{"b":{}}}}}`},
		{name: "conflicting tiered spellings", payload: `{"models":{"model-m":{"tieredModelIds":{},"tiered_model_ids":{}}}}`},
		{name: "invalid tier detail", payload: `{"models":{"model-m":{"tieredModelIds":{"low":{}}}}}`},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if _, err := decodeModelIDs([]byte(testCase.payload)); !errors.Is(err, ErrInvalidUpstreamResponse) {
				t.Fatalf("decodeModelIDs() error = %v, want ErrInvalidUpstreamResponse", err)
			}
		})
	}
}

func TestDecodeModelIDsIgnoresUnrelatedMetadataDrift(t *testing.T) {
	t.Parallel()

	models, err := decodeModelIDs([]byte(`{
		"models": {
			"claude-opus-4-6-thinking": {
				"newCapabilityFlag": {"version": 2},
				"tieredModelIds": {"fast": "claude-sonnet-4-6"}
			}
		},
		"newCatalogMetadata": {"revision": "future"}
	}`))
	if err != nil {
		t.Fatalf("decodeModelIDs() error = %v", err)
	}
	want := []string{"claude-opus-4-6-thinking", "claude-sonnet-4-6"}
	if strings.Join(models, "\n") != strings.Join(want, "\n") {
		t.Fatalf("models = %v, want %v", models, want)
	}
}
