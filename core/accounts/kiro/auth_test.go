package kiro

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const testEndpoint = "https://codewhisperer.us-east-1.amazonaws.com"

func testPayload(t *testing.T, overrides map[string]any) []byte {
	t.Helper()
	document := map[string]any{
		"auth": map[string]any{
			"access_token":  "aoa-old",
			"refresh_token": "aor-old",
			"expires_at":    "2026-11-05T00:00:00.000Z",
			"region":        "us-east-1",
			"profile_arn":   "arn:aws:codewhisperer:us-east-1:123:profile/X",
		},
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     testEndpoint,
			"subject":      "d-9067642ac7.4488248",
			"tokenBinding": "placeholder",
			"observedAtMs": 1_700_000_000_000,
		},
		"flavor": "oidc",
		"registration": map[string]any{
			"clientId":     "client-id",
			"clientSecret": "client-secret",
			"region":       "us-east-1",
		},
	}
	for key, value := range overrides {
		document[key] = value
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var auth map[string]json.RawMessage
	_ = json.Unmarshal(parsed["auth"], &auth)
	if !RebindIdentityEvidence(parsed, auth) {
		t.Fatal("RebindIdentityEvidence failed")
	}
	result, err := json.Marshal(parsed)
	if err != nil {
		t.Fatalf("marshal rebound: %v", err)
	}
	return result
}

func TestParseCredentialReadsBothFlavors(t *testing.T) {
	t.Parallel()
	oidc, err := ParseCredential(testPayload(t, nil))
	if err != nil {
		t.Fatalf("ParseCredential() error = %v", err)
	}
	if oidc.Flavor() != FlavorOIDC || oidc.ClientID() != "client-id" || oidc.Region() != "us-east-1" {
		t.Fatalf("oidc = %#v", oidc)
	}
	if !strings.HasSuffix(oidc.ProfileARN(), "profile/X") {
		t.Fatalf("profileARN = %q", oidc.ProfileARN())
	}

	desktopPayload := []byte(`{
		"auth": {"access_token":"aoa-2","refresh_token":"aor-2","expires_at":"2026-11-05T00:00:00.000Z","region":"us-east-1"},
		"flavor": "desktop",
		"profileArn": "arn:aws:codewhisperer:us-east-1:123:profile/D"
	}`)
	desktop, err := ParseCredential(desktopPayload)
	if err != nil {
		t.Fatalf("ParseCredential(desktop) error = %v", err)
	}
	if desktop.Flavor() != FlavorDesktop || desktop.ProfileARN() == "" || desktop.CanRefresh() != true {
		t.Fatalf("desktop = %#v", desktop)
	}
}

func TestCredentialFreshness(t *testing.T) {
	t.Parallel()
	credential, err := ParseCredential(testPayload(t, nil))
	if err != nil {
		t.Fatalf("ParseCredential() error = %v", err)
	}
	if credential.IsAccessTokenFresh(time.Date(2026, 11, 4, 22, 0, 0, 0, time.UTC)) != true {
		t.Fatal("token should be fresh before the skew window")
	}
	if credential.IsAccessTokenFresh(time.Date(2026, 11, 4, 23, 59, 30, 0, time.UTC)) != false {
		t.Fatal("token should be stale inside the skew window")
	}
}

func TestWithGrantRebindsIdentityEvidence(t *testing.T) {
	t.Parallel()
	payload := testPayload(t, nil)
	credential, err := ParseCredential(payload)
	if err != nil {
		t.Fatalf("ParseCredential() error = %v", err)
	}
	updated, err := credential.WithGrant(Grant{
		AccessToken:  "aoa-new",
		RefreshToken: "aor-new",
		ExpiresAt:    time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC),
		Region:       "us-east-1",
	})
	if err != nil {
		t.Fatalf("WithGrant() error = %v", err)
	}
	decoded, err := nativeaccount.NewDecoder().DecodeNativeAuth("kiro", updated)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	if decoded.ProviderID() != "kiro" {
		t.Fatalf("provider = %q", decoded.ProviderID())
	}
	refreshed, err := ParseCredential(updated)
	if err != nil {
		t.Fatalf("ParseCredential(updated) error = %v", err)
	}
	if refreshed.AccessToken() != "aoa-new" || refreshed.RefreshToken() != "aor-new" {
		t.Fatalf("tokens = %q / %q", refreshed.AccessToken(), refreshed.RefreshToken())
	}
	if !refreshed.ExpiresAt().Equal(time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("expiresAt = %v", refreshed.ExpiresAt())
	}
	// 身份种子必须保持不变（endpoint + subject 未变）。
	before, err := nativeaccount.NewDecoder().DecodeNativeAuth("kiro", payload)
	if err != nil {
		t.Fatalf("decode before error = %v", err)
	}
	if before.IdentitySeed() != decoded.IdentitySeed() {
		t.Fatalf("identity seed changed: %q -> %q", before.IdentitySeed(), decoded.IdentitySeed())
	}
}
