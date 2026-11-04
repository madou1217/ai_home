package modelcatalog

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func zcodeCredential(t *testing.T, token string) accountapp.Credential {
	t.Helper()
	return zcodeCredentialWithPaasToken(t, token, "")
}

func zcodeCredentialWithPaasToken(t *testing.T, token string, paasToken string) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("zcode", "user-1")
	if err != nil {
		t.Fatal(err)
	}
	credentials := `"zcodejwttoken":"` + token + `"`
	if paasToken != "" {
		credentials += `,"oauth:bigmodel:access_token":"` + paasToken + `"`
	}
	payload := []byte(`{"credentials":{` + credentials + `}}`)
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func testZcodeSource(t *testing.T, handler func(path string, request *http.Request) (int, string)) *Source {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		status, payload := handler(request.URL.Path, request)
		response.WriteHeader(status)
		_, _ = response.Write([]byte(payload))
	}))
	t.Cleanup(server.Close)
	source, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	source.balanceURL = server.URL + "/balance"
	source.previewURL = server.URL + "/preview"
	source.paasModelsURL = server.URL + "/paas/models"
	return source
}

func TestDiscoverModelsReadsBalanceCapabilities(t *testing.T) {
	t.Parallel()
	source := testZcodeSource(t, func(path string, request *http.Request) (int, string) {
		if request.Header.Get("Authorization") != "Bearer jwt-test" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("X-Device-Mid") == "" || request.Header.Get("X-ZCode-App-Version") == "" {
			t.Errorf("missing client metadata headers")
		}
		if request.URL.Query().Get("app_version") == "" {
			t.Errorf("missing app_version")
		}
		return http.StatusOK, `{"code":0,"data":{"balances":[
			{"capabilities":["model:glm-5.3","model:opencode-go/x","model:glm-5.3-flash"]}
		]}}`
	})
	models, err := source.DiscoverModels(context.Background(), zcodeCredential(t, "jwt-test"))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "glm-5.3,glm-5.3-flash" {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsFallsBackToPreview(t *testing.T) {
	t.Parallel()
	source := testZcodeSource(t, func(path string, _ *http.Request) (int, string) {
		if strings.HasSuffix(path, "/balance") {
			return http.StatusOK, `{"code":0,"data":{"balances":[]}}`
		}
		return http.StatusOK, `{"code":0,"data":{"plans":[
			{"entitlements":[{"capabilities":["model:glm-5.3","model:glm-4-plus"]}]}
		]}}`
	})
	models, err := source.DiscoverModels(context.Background(), zcodeCredential(t, "jwt-test"))
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if strings.Join(models, ",") != "glm-4-plus,glm-5.3" {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsReportsEmptyCatalog(t *testing.T) {
	t.Parallel()
	source := testZcodeSource(t, func(string, *http.Request) (int, string) {
		return http.StatusOK, `{"code":0,"data":{"balances":[],"plans":[]}}`
	})
	if _, err := source.DiscoverModels(context.Background(), zcodeCredential(t, "jwt-test")); err != ErrEmptyCatalog {
		t.Fatalf("error = %v", err)
	}
}

func TestDiscoverModelsFallsBackToPaasCatalog(t *testing.T) {
	t.Parallel()
	source := testZcodeSource(t, func(path string, request *http.Request) (int, string) {
		switch {
		case strings.HasSuffix(path, "/balance"):
			return http.StatusOK, `{"code":0,"data":{"balances":[]}}`
		case strings.HasSuffix(path, "/preview"):
			return http.StatusOK, `{"code":0,"data":{"plans":[]}}`
		default:
			if request.Header.Get("Authorization") != "Bearer paas-token" {
				t.Errorf("authorization = %q", request.Header.Get("Authorization"))
			}
			return http.StatusOK, `{"data":[{"id":"glm-5.2"},{"id":"gpt-5"},{"id":"glm-5.2"}]}`
		}
	})
	models, err := source.DiscoverModels(
		context.Background(),
		zcodeCredentialWithPaasToken(t, "jwt-test", "paas-token"),
	)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "glm-5.2" {
		t.Fatalf("models = %v", models)
	}
}

func TestDiscoverModelsRejectsMissingJWT(t *testing.T) {
	t.Parallel()
	source := testZcodeSource(t, func(string, *http.Request) (int, string) {
		return http.StatusOK, `{}`
	})
	if _, err := source.DiscoverModels(context.Background(), zcodeCredential(t, "")); err != ErrUnsupportedCredential {
		t.Fatalf("error = %v", err)
	}
}

func TestRoutableFiltersPartnerNamespaces(t *testing.T) {
	t.Parallel()
	for id, expected := range map[string]bool{
		"glm-5.3":       true,
		"zcode-v3":      true,
		"opencode-go/x": false,
		"cline-free/y":  false,
		"gpt-5":         false,
	} {
		if routable(id) != expected {
			t.Fatalf("routable(%q) = %v", id, !expected)
		}
	}
}
