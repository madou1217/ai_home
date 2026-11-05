package zcoderelay

import (
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func resolveWith(t *testing.T, body string, host HostFacts) relaycore.Provider {
	t.Helper()
	provider := NewProvider(host)
	resolved, ok := provider.Resolve(relaycore.ResolveInput{
		ProviderID: "zcode",
		AccountRef: "acct_00000000000000000001",
		Credential: nativeCredential(t, "zcode", body),
	})
	if !ok || resolved == nil {
		t.Fatal("zcode 必须被本通道认领")
	}
	return resolved
}

func TestProviderResolvesStartPlanToJWTEndpoint(t *testing.T) {
	provider := resolveWith(t, `{"credentials":{"zcodejwttoken":"jwt-1"}}`, HostFacts{DeviceMid: "mid-1"})
	endpoint, ok := provider.Endpoint()
	if !ok || endpoint != PlanJWTBaseURL+Path {
		t.Fatalf("endpoint = %q, ok=%v", endpoint, ok)
	}
	token, err := provider.AccessToken(nil)
	if err != nil || token != "jwt-1" {
		t.Fatalf("token = %q, err=%v", token, err)
	}
	request, _ := http.NewRequest(http.MethodPost, endpoint, nil)
	provider.DecorateUpstream(request, token)
	if request.Header.Get("Authorization") != "Bearer jwt-1" {
		t.Fatalf("Authorization = %q", request.Header.Get("Authorization"))
	}
	if request.Header.Get("X-Zcode-Authorization") != "" {
		t.Fatal("zcode-plan 端点不应带双头")
	}
	if request.Header.Get("X-Zcode-Agent") != IdentityAgent {
		t.Fatal("必须补客户端身份头")
	}
}

func TestProviderResolvesCodingPlanToUltraDualAuth(t *testing.T) {
	provider := resolveWith(t, `{"credentials":{"zcodejwttoken":"jwt-1","oauth:bigmodel:access_token":"at-1"}}`, HostFacts{})
	// plan_id 由额度文档注入（下一轮接线）；这里直接给变体设置事实。
	variant, ok := provider.(*Provider)
	if !ok {
		t.Fatal("Resolve 必须返回 *Provider")
	}
	variant.facts.PlanID = "zcode-v3-individual-coding-plan-0817"
	variant.baseURL = ResolveInferenceBaseURL(variant.facts.PlanID, variant.facts.Region)
	endpoint, ok := provider.Endpoint()
	if !ok || endpoint != UltraBigmodelBaseURL+Path {
		t.Fatalf("endpoint = %q, ok=%v", endpoint, ok)
	}
	token, err := provider.AccessToken(nil)
	if err != nil || token != "at-1" {
		t.Fatalf("ultra 的 Authorization 用区域 access_token: %q %v", token, err)
	}
	request, _ := http.NewRequest(http.MethodPost, endpoint, nil)
	provider.DecorateUpstream(request, token)
	if request.Header.Get("X-Zcode-Authorization") != "Bearer jwt-1" {
		t.Fatalf("ultra 必须带第二个鉴权头: %q", request.Header.Get("X-Zcode-Authorization"))
	}
}

func TestProviderClaimsWithoutCredentialButFailsClosed(t *testing.T) {
	provider := NewProvider(HostFacts{})
	resolved, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "zcode"})
	if !ok {
		t.Fatal("能力判定阶段也必须认领")
	}
	if _, ok := resolved.Endpoint(); ok {
		t.Fatal("没有凭据时不应给出端点（交还 Canonical）")
	}
	if _, err := resolved.AccessToken(nil); err == nil {
		t.Fatal("没有凭据时必须报不支持")
	}
}

func TestProviderRewriteRequestAppliesHarness(t *testing.T) {
	provider := resolveWith(t, `{"credentials":{"zcodejwttoken":"jwt-1"}}`, HostFacts{
		HarnessBlocks: officialBlocks(),
		DeviceMid:     "mid-1",
	})
	original := `{"model":"glm-5.3","system":"client","messages":[]}`
	result, err := provider.RewriteRequest([]byte(original))
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Body) == original {
		t.Fatal("有 harness 时必须整形")
	}
}
