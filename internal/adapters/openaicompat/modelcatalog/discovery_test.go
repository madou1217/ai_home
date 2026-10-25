package modelcatalog

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
)

func TestParseModelDescriptorsMatchesNodeBooleanProjection(t *testing.T) {
	payload := []byte(`{"data":[
    {"id":"kimi-image","supports_image_in":true,"supports_video_in":false},
    {"id":"kimi-missing","supports_image_in":true},
    {"id":"kimi-malformed","supports_image_in":"true","supports_video_in":false},
    {"id":"kimi-text","supports_image_in":false,"supports_video_in":false}
  ]}`)
	descriptors := ParseModelDescriptors("kimi", payload)
	if len(descriptors) != 4 {
		t.Fatalf("descriptor count = %d, want 4", len(descriptors))
	}
	byID := make(map[string]modelmetadata.ModelDescriptor, len(descriptors))
	for _, descriptor := range descriptors {
		byID[descriptor.ModelID().String()] = descriptor
	}
	image := byID["kimi-image"].Modalities()
	if got := image.Input(); len(got) != 2 || got[1] != "image" {
		t.Fatalf("image input modalities = %#v, want [text image]", got)
	}
	if got := byID["kimi-text"].Modalities().Input(); len(got) != 1 || got[0] != "text" {
		t.Fatalf("text input modalities = %#v, want [text]", got)
	}
	if got := byID["kimi-image"].Modalities().Output(); len(got) != 1 || got[0] != "text" {
		t.Fatalf("output modalities = %#v, want [text]", got)
	}
	if got := byID["kimi-missing"].Modalities().Input(); len(got) != 2 || got[1] != "image" {
		t.Fatalf("kimi-missing input modalities = %#v, want [text image]", got)
	}
	if got := byID["kimi-malformed"].Modalities().Input(); len(got) != 1 || got[0] != "text" {
		t.Fatalf("kimi-malformed input modalities = %#v, want [text]", got)
	}
}

func TestParseModelsKeepsIDsWhenDescriptorFactsAreInvalid(t *testing.T) {
	payload := []byte(`{"data":[{"id":"kimi-missing","supports_image_in":true},{"id":"kimi-malformed","supports_image_in":"true"}]}`)
	models := ParseModels(payload)
	if len(models) != 2 || models[0] != "kimi-missing" || models[1] != "kimi-malformed" {
		t.Fatalf("models = %#v, want both IDs", models)
	}
}

func TestSourcePublishesDescriptorsOnlyAfterSuccessfulCatalog(t *testing.T) {
	sink := &descriptorSinkProbe{}
	client := &modelCatalogHTTPProbe{status: http.StatusOK, body: []byte(`{"data":[{"id":"kimi-image","supports_image_in":true,"supports_video_in":false}]}`)}
	source, err := New(client, Options{
		ProviderID: "kimi",
		Endpoint:   "https://example.test/models",
		Token: func(accountapp.Credential) (string, error) {
			return "token", nil
		},
		Descriptors: sink,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), testCredential{provider: "kimi"})
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != 1 || models[0] != "kimi-image" {
		t.Fatalf("models = %#v, want kimi-image", models)
	}
	if sink.calls != 1 || len(sink.descriptors) != 1 {
		t.Fatalf("sink calls/descriptors = %d/%d, want 1/1", sink.calls, len(sink.descriptors))
	}

	client.status = http.StatusBadGateway
	client.body = []byte(`{"data":[{"id":"kimi-other","supports_image_in":true,"supports_video_in":false}]}`)
	if _, err := source.DiscoverModels(context.Background(), testCredential{provider: "kimi"}); err == nil {
		t.Fatalf("HTTP failure DiscoverModels() error = nil, want error")
	}
	if sink.calls != 1 {
		t.Fatalf("sink calls after HTTP failure = %d, want unchanged 1", sink.calls)
	}
}

type descriptorSinkProbe struct {
	calls       int
	providerID  string
	descriptors []modelmetadata.ModelDescriptor
}

func (probe *descriptorSinkProbe) ReplaceModelDescriptors(providerID string, descriptors []modelmetadata.ModelDescriptor) error {
	probe.calls++
	probe.providerID = providerID
	probe.descriptors = append([]modelmetadata.ModelDescriptor(nil), descriptors...)
	return nil
}

type modelCatalogHTTPProbe struct {
	status int
	body   []byte
}

func (probe *modelCatalogHTTPProbe) Do(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: probe.status,
		Body:       io.NopCloser(bytes.NewReader(probe.body)),
		Header:     make(http.Header),
	}, nil
}

type testCredential struct{ provider string }

func (credential testCredential) ProviderID() string   { return credential.provider }
func (credential testCredential) IdentitySeed() string { return "test:identity" }
func (credential testCredential) String() string       { return "test-credential" }
func (credential testCredential) GoString() string     { return credential.String() }
