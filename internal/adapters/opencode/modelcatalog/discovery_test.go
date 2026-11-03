package modelcatalog

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type httpProbe struct {
	request *http.Request
	status  int
	body    []byte
}

func (probe *httpProbe) Do(request *http.Request) (*http.Response, error) {
	probe.request = request
	return &http.Response{StatusCode: probe.status, Body: io.NopCloser(bytes.NewReader(probe.body)), Header: make(http.Header)}, nil
}

func catalogCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{{Upstream: "opencode-go", Type: "api", Secret: "sk-test"}})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"opencode-go":{"type":"api","key":"sk-test"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func TestDiscoverModelsUsesOpenCodeGoEndpointAndNamespace(t *testing.T) {
	probe := &httpProbe{status: http.StatusOK, body: []byte(`{"data":[{"id":"deepseek-v4"},{"id":"opencode-go/qwen3.7"},{"id":"deepseek-v4"}]}`)}
	source, err := New(probe)
	if err != nil {
		t.Fatal(err)
	}
	models, err := source.DiscoverModels(context.Background(), catalogCredential(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0] != "opencode-go/deepseek-v4" || models[1] != "opencode-go/qwen3.7" {
		t.Fatalf("models = %#v", models)
	}
	if probe.request.URL.String() != "https://opencode.ai/zen/go/v1/models" {
		t.Fatalf("URL = %s", probe.request.URL)
	}
	if probe.request.Header.Get("Authorization") != "Bearer sk-test" {
		t.Fatalf("authorization = %q", probe.request.Header.Get("Authorization"))
	}
}
