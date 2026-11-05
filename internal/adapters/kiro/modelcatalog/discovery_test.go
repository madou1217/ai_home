package modelcatalog

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

func nativeKiroCredential(t *testing.T, profileARN string) accountapp.Credential {
	t.Helper()
	auth := map[string]any{
		"access_token":  "aoa-test",
		"refresh_token": "aor-test",
		"expires_at":    "2099-01-01T00:00:00.000Z",
		"region":        "us-east-1",
	}
	if profileARN != "" {
		auth["profile_arn"] = profileARN
	}
	document := map[string]any{
		"auth": auth,
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     "https://codewhisperer.us-east-1.amazonaws.com",
			"subject":      "d-1",
			"tokenBinding": "placeholder",
			"observedAtMs": 1_700_000_000_000,
		},
		"flavor": "oidc",
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &parsed)
	var parsedAuth map[string]json.RawMessage
	_ = json.Unmarshal(parsed["auth"], &parsedAuth)
	if !kiro.RebindIdentityEvidence(parsed, parsedAuth) {
		t.Fatal("rebind failed")
	}
	payload, _ := json.Marshal(parsed)
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("kiro", payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	return credential
}

type recordedRequest struct {
	path    string
	target  string
	body    string
	auth    string
	content string
}

func testSource(t *testing.T, handler func(request recordedRequest) (int, string)) (*Source, *[]recordedRequest) {
	t.Helper()
	requests := make([]recordedRequest, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		recorded := recordedRequest{
			path:    request.URL.Path,
			target:  request.Header.Get("x-amz-target"),
			body:    string(body),
			auth:    request.Header.Get("Authorization"),
			content: request.Header.Get("Content-Type"),
		}
		requests = append(requests, recorded)
		status, payload := handler(recorded)
		response.WriteHeader(status)
		_, _ = response.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	source, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.managementBaseURL = func(string) string { return server.URL + "/management/" }
	source.codeWhispererBase = func(string) string { return server.URL + "/codewhisperer/" }
	return source, &requests
}

func TestDiscoverModelsUsesV3WithProfileARN(t *testing.T) {
	t.Parallel()
	source, requests := testSource(t, func(request recordedRequest) (int, string) {
		if !strings.HasSuffix(request.path, "/management/") {
			t.Errorf("path = %q", request.path)
		}
		return http.StatusOK, `{"models":[{"modelId":"claude-sonnet-4.5"},{"modelName":"claude-haiku-4.5"}],"defaultModel":{"modelId":"auto"}}`
	})
	models, err := source.DiscoverModels(context.Background(), nativeKiroCredential(t, "arn:aws:codewhisperer:us-east-1:123:profile/X"))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	expected := []string{"auto", "claude-haiku-4.5", "claude-sonnet-4.5"}
	if strings.Join(models, ",") != strings.Join(expected, ",") {
		t.Fatalf("models = %v", models)
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %d", len(*requests))
	}
	recorded := (*requests)[0]
	if recorded.target != targetV3 {
		t.Fatalf("target = %q", recorded.target)
	}
	if !strings.Contains(recorded.body, `"profileArn"`) || !strings.Contains(recorded.body, "KIRO_CLI") {
		t.Fatalf("body = %s", recorded.body)
	}
	if recorded.auth != "Bearer aoa-test" || recorded.content != contentType {
		t.Fatalf("headers = %q / %q", recorded.auth, recorded.content)
	}
}

func TestDiscoverModelsFallsBackToV2(t *testing.T) {
	t.Parallel()
	source, requests := testSource(t, func(request recordedRequest) (int, string) {
		if strings.HasSuffix(request.path, "/management/") {
			return http.StatusServiceUnavailable, "unavailable"
		}
		return http.StatusOK, `{"models":[{"modelId":"claude-sonnet-4.5"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), nativeKiroCredential(t, "arn:aws:codewhisperer:us-east-1:123:profile/X"))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "claude-sonnet-4.5" {
		t.Fatalf("models = %v", models)
	}
	if len(*requests) != 2 {
		t.Fatalf("requests = %d", len(*requests))
	}
	if (*requests)[1].target != targetV2 || !strings.Contains((*requests)[1].body, "CLI") {
		t.Fatalf("v2 request = %#v", (*requests)[1])
	}
}

func TestDiscoverModelsResolvesSingleProfile(t *testing.T) {
	t.Parallel()
	source, requests := testSource(t, func(request recordedRequest) (int, string) {
		switch request.target {
		case targetProfiles:
			return http.StatusOK, `{"profiles":[{"arn":"arn:aws:codewhisperer:us-east-1:123:profile/ONLY"}]}`
		case targetV3:
			return http.StatusOK, `{"models":[{"modelId":"claude-haiku-4.5"}]}`
		default:
			return http.StatusInternalServerError, "unexpected"
		}
	})
	models, err := source.DiscoverModels(context.Background(), nativeKiroCredential(t, ""))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "claude-haiku-4.5" {
		t.Fatalf("models = %v", models)
	}
	if len(*requests) != 2 {
		t.Fatalf("requests = %d", len(*requests))
	}
	if (*requests)[1].target != targetV3 || !strings.Contains((*requests)[1].body, "profile/ONLY") {
		t.Fatalf("v3 request = %#v", (*requests)[1])
	}
}

func TestDiscoverModelsFallsBackToBuilderIDProfile(t *testing.T) {
	t.Parallel()
	source, requests := testSource(t, func(request recordedRequest) (int, string) {
		switch request.target {
		case targetProfiles:
			return http.StatusForbidden, `{"message":"AWS Builder ID is not supported for this operation"}`
		default:
			return http.StatusOK, `{"models":[{"modelId":"claude-sonnet-4.5"}]}`
		}
	})
	models, err := source.DiscoverModels(context.Background(), nativeKiroCredential(t, ""))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 {
		t.Fatalf("models = %v", models)
	}
	if (*requests)[1].target != targetV3 || !strings.Contains((*requests)[1].body, "638616132270") {
		t.Fatalf("v3 request = %#v", (*requests)[1])
	}
}

func TestDiscoverModelsSkipsV3WhenProfilesAreAmbiguous(t *testing.T) {
	t.Parallel()
	source, requests := testSource(t, func(request recordedRequest) (int, string) {
		if request.target == targetProfiles {
			return http.StatusOK, `{"profiles":[{"arn":"arn:a"},{"arn":"arn:b"}]}`
		}
		return http.StatusOK, `{"models":[{"modelId":"claude-haiku-4.5"}]}`
	})
	models, err := source.DiscoverModels(context.Background(), nativeKiroCredential(t, ""))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 {
		t.Fatalf("models = %v", models)
	}
	for _, request := range *requests {
		if request.target == targetV3 {
			t.Fatalf("v3 must not be called: %#v", request)
		}
	}
}

func TestDiscoverModelsRejectsUnknownCredential(t *testing.T) {
	t.Parallel()
	source, _ := testSource(t, func(recordedRequest) (int, string) {
		return http.StatusOK, `{}`
	})
	if _, err := source.DiscoverModels(context.Background(), fakeCredential{}); err != ErrUnsupportedCredential {
		t.Fatalf("error = %v", err)
	}
}

type fakeCredential struct{}

func (fakeCredential) ProviderID() string   { return "kiro" }
func (fakeCredential) IdentitySeed() string { return "oauth:kiro:user:x" }
func (fakeCredential) String() string       { return "fakeCredential" }
func (fakeCredential) GoString() string     { return "fakeCredential" }
