package zcoderelay

import (
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func nativeCredential(t *testing.T, provider, body string) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity(provider, "user_01ABC")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func TestExtractFactsFromNativePayload(t *testing.T) {
	credential := nativeCredential(t, "zcode", "{\"credentials\":{"+
		"\"zcodejwttoken\":\"jwt-1\","+
		"\"oauth:bigmodel:access_token\":\"at-1\","+
		"\"oauth:active_provider\":\"enc:v1:xx\"}}")
	facts, err := ExtractFacts(credential)
	if err != nil {
		t.Fatal(err)
	}
	if facts.JWT != "jwt-1" || facts.AccessToken != "at-1" || facts.Region != "bigmodel" {
		t.Fatalf("facts = %#v", facts)
	}
	if facts.PlanID != "" {
		t.Fatalf("plan_id 缺失时应为空（回落 zcode-plan 端点）: %q", facts.PlanID)
	}
}

func TestExtractFactsRejectsWrongProviderOrMissingJWT(t *testing.T) {
	other := nativeCredential(t, "kimi", "{\"credentials\":{\"zcodejwttoken\":\"jwt\"}}")
	if _, err := ExtractFacts(other); err == nil {
		t.Fatal("非 zcode 凭据必须拒绝")
	}
	noJWT := nativeCredential(t, "zcode", "{\"credentials\":{\"oauth:zai:access_token\":\"at\"}}")
	if _, err := ExtractFacts(noJWT); err == nil {
		t.Fatal("缺少长期 jwt 必须拒绝")
	}
}

func TestEndpointForChoosesDualAuthForCodingPlan(t *testing.T) {
	url, headers, err := EndpointFor(Facts{JWT: "jwt", AccessToken: "at", Region: "zai", PlanID: "zcode-v3-individual-coding-plan-0817"})
	if err != nil {
		t.Fatal(err)
	}
	if url != UltraZAIBaseURL+Path {
		t.Fatalf("url = %q", url)
	}
	if headers["X-Zcode-Authorization"] != "Bearer jwt" || headers["Authorization"] != "Bearer at" {
		t.Fatalf("headers = %#v", headers)
	}
}

func TestEndpointForUsesJWTOnlyForStartPlan(t *testing.T) {
	url, headers, err := EndpointFor(Facts{JWT: "jwt", Region: "bigmodel", PlanID: "zcode-v3-start-plan-1024"})
	if err != nil {
		t.Fatal(err)
	}
	if url != PlanJWTBaseURL+Path || headers["Authorization"] != "Bearer jwt" {
		t.Fatalf("url=%q headers=%#v", url, headers)
	}
	if _, ok := headers["X-Zcode-Authorization"]; ok {
		t.Fatal("start-plan 不应带双头")
	}
}
