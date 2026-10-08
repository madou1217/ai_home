package codeassist

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
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

// 废弃 ID 是仍可请求的公开入口，即使它只出现在上游转发表里也不能丢失。
func TestDecodeModelIDsRetainsDeprecatedPublicModelIDs(t *testing.T) {
	t.Parallel()

	models, err := decodeModelIDs([]byte(`{
		"models": {"gemini-pro-agent": {}},
		"deprecatedModelIds": {
			"gemini-3.1-pro-high": {"newModelId": "gemini-pro-agent"}
		}
	}`))
	if err != nil {
		t.Fatalf("decodeModelIDs() error = %v", err)
	}
	want := []string{"gemini-3.1-pro-high", "gemini-pro-agent"}
	if strings.Join(models, "\n") != strings.Join(want, "\n") {
		t.Fatalf("models = %v, want %v", models, want)
	}
}

func TestModelDiscoveryKeepsLastGoodWiresUntilACompleteSuccessfulRefresh(t *testing.T) {
	t.Parallel()

	payload := `{"models":{"new":{}},"deprecatedModelIds":{"old":"new"}}`
	status := http.StatusOK
	client := recordingClient{do: func(request *http.Request) (*http.Response, error) {
		if strings.Contains(request.URL.String(), ":loadCodeAssist") {
			return jsonResponse(http.StatusOK, `{"cloudaicompanionProject":"project-123"}`), nil
		}
		return jsonResponse(status, payload), nil
	}}
	store := NewModelWireStore("")
	source, err := NewModelCatalogSourceWithWireModels(client, store)
	if err != nil {
		t.Fatal(err)
	}
	auth := testAgyAuth(t)
	ref, _ := accountcore.DeriveAccountRef(auth)
	if _, err := source.DiscoverModels(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	status = http.StatusServiceUnavailable
	if _, err := source.DiscoverModels(context.Background(), auth); err == nil || store.Resolve(ref, "old") != "new" {
		t.Fatalf("failed refresh error=%v wire=%q", err, store.Resolve(ref, "old"))
	}
	status = http.StatusOK
	payload = `{"models":{"new":true}}`
	if _, err := source.DiscoverModels(context.Background(), auth); err == nil || store.Resolve(ref, "old") != "new" {
		t.Fatalf("malformed refresh error=%v wire=%q", err, store.Resolve(ref, "old"))
	}
	payload = `{"models":{"old":{}}}`
	if _, err := source.DiscoverModels(context.Background(), auth); err != nil || store.Resolve(ref, "old") != "old" {
		t.Fatalf("successful refresh error=%v wire=%q", err, store.Resolve(ref, "old"))
	}
}
