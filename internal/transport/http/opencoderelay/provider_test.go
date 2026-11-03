package opencoderelay

import (
	"encoding/json"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{
		{Upstream: "opencode-go", Type: "api", Secret: "sk-test"},
		{Upstream: "opencode", Type: "api", Secret: "sk-test"},
	})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"opencode-go":{"type":"api","key":"sk-test"},"opencode":{"type":"api","key":"sk-test"}}}`))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestProviderResolvesGoAndZenEndpointsAndStripsNamespace(t *testing.T) {
	provider := NewProvider()
	goModel, err := runtimeModel("opencode-go/deepseek-v4")
	if err != nil {
		t.Fatal(err)
	}
	goResolved, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: ProviderID, ModelID: goModel})
	if !ok {
		t.Fatal("go model was not resolved")
	}
	endpoint, ok := goResolved.Endpoint()
	if !ok || endpoint != GoBaseURL+ChatCompletionsPath {
		t.Fatalf("go endpoint = %q", endpoint)
	}
	zenModel, err := runtimeModel("opencode/deepseek-v4")
	if err != nil {
		t.Fatal(err)
	}
	zenResolved, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: ProviderID, ModelID: zenModel})
	if !ok {
		t.Fatal("zen model was not resolved")
	}
	endpoint, ok = zenResolved.Endpoint()
	if !ok || endpoint != ZenBaseURL+ChatCompletionsPath {
		t.Fatalf("zen endpoint = %q", endpoint)
	}
	rewritten, err := zenResolved.RewriteRequest([]byte(`{"model":"opencode/deepseek-v4","messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(rewritten.Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["model"] != "deepseek-v4" {
		t.Fatalf("rewritten model = %#v", body["model"])
	}
}

func TestProviderRejectsOAuthCredentialAndExtractsAPIKey(t *testing.T) {
	credential := testCredential(t)
	provider := NewProvider()
	if !SupportsCredential(credential) {
		t.Fatal("API key credential was rejected")
	}
	token, err := provider.AccessToken(credential)
	if err != nil || token != "sk-test" {
		t.Fatalf("token = %q, err = %v", token, err)
	}
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{{Upstream: "opencode-go", Type: "oauth", Subject: "user-1"}})
	if err != nil {
		t.Fatal(err)
	}
	oauth, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{"opencode-go":{"type":"oauth","access":"token","refresh":"refresh","id":"user-1"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if SupportsCredential(oauth) {
		t.Fatal("OAuth credential was accepted")
	}
	if _, err := provider.AccessToken(oauth); err != relaycore.ErrUnsupportedCredential {
		t.Fatalf("OAuth error = %v", err)
	}
}

func runtimeModel(value string) (runtimecore.ModelID, error) { return runtimecore.NewModelID(value) }
