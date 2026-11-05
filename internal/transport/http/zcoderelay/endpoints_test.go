package zcoderelay

import "testing"

func TestResolveInferenceBaseURL(t *testing.T) {
	cases := []struct {
		planID string
		region string
		want   string
	}{
		{"zcode-v3-start-plan-1024", "zai", PlanJWTBaseURL},
		{"zcode-v3-start-plan-1024", "", PlanJWTBaseURL},
		{"", "zai", PlanJWTBaseURL},
		{"", "", PlanJWTBaseURL},
		{"zcode-v3-individual-coding-plan-0817", "zai", UltraZAIBaseURL},
		{"zcode-v3-individual-coding-plan-0817", "bigmodel", UltraBigmodelBaseURL},
		{"zcode-v3-team-coding-plan-0901", "zai", UltraZAIBaseURL},
		{"zcode-v3-individual-coding-plan-0817", "", UltraBigmodelBaseURL},
		{"unknown-plan", "bigmodel", UltraBigmodelBaseURL},
		{"unknown-plan", "", PlanJWTBaseURL},
	}
	for _, tc := range cases {
		if got := ResolveInferenceBaseURL(tc.planID, tc.region); got != tc.want {
			t.Errorf("ResolveInferenceBaseURL(%q, %q) = %q, want %q", tc.planID, tc.region, got, tc.want)
		}
	}
}

func TestAuthHeadersPerEndpoint(t *testing.T) {
	headers, err := AuthHeaders(PlanJWTBaseURL, "access", "jwt")
	if err != nil {
		t.Fatal(err)
	}
	if headers["Authorization"] != "Bearer jwt" {
		t.Fatalf("zcode-plan 端点只认 jwt: %#v", headers)
	}
	if _, ok := headers["X-Zcode-Authorization"]; ok {
		t.Fatal("zcode-plan 端点不应带双头")
	}

	headers, err = AuthHeaders(UltraZAIBaseURL, "access", "jwt")
	if err != nil {
		t.Fatal(err)
	}
	if headers["Authorization"] != "Bearer access" || headers["X-Zcode-Authorization"] != "Bearer jwt" {
		t.Fatalf("ultra 端点必须双头: %#v", headers)
	}
}

func TestAuthHeadersRejectsMissingCredential(t *testing.T) {
	if _, err := AuthHeaders(PlanJWTBaseURL, "access", ""); err == nil {
		t.Fatal("缺 jwt 必须报错")
	}
	if _, err := AuthHeaders(UltraBigmodelBaseURL, "", "jwt"); err == nil {
		t.Fatal("ultra 缺 access_token 必须报错")
	}
	if _, err := AuthHeaders("", "a", "j"); err == nil {
		t.Fatal("空端点必须报错")
	}
}
