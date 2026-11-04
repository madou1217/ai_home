package nativeaccount

import (
	"encoding/json"
	"testing"
)

func TestOpenCodeOAuthOpaqueTokensUseMetadataSubject(t *testing.T) {
	native := map[string]any{
		"auth": map[string]any{
			"opencode": map[string]any{
				"type":     "oauth",
				"methodID": "device",
				"refresh":  "rt_36171c70-ee99-4ef1-949f-13de80f92364",
				"access":   "st_67adcf29-2545-4afe-a0e5-a4df80fc5d9c",
				"expires":  float64(1795856726735),
				"metadata": map[string]any{
					"server":    "https://opencode.ai/console",
					"accountID": "acc_01KEVGHRSC692BY6NMNTSMVZDA",
					"email":     "user@example.com",
					"orgID":     "wrk_01KEVGHS7YWJHR5M9XDMCGKYZX",
					"orgName":   "Default",
				},
			},
		},
	}
	identity, err := openCodeIdentity("opencode", native)
	if err != nil {
		t.Fatalf("openCodeIdentity error = %v", err)
	}
	if identity.IdentitySeed() == "" {
		t.Fatal("identity seed is empty")
	}
	payload, err := json.Marshal(native)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewDecoder().DecodeNativeAuth("opencode", payload); err != nil {
		t.Fatalf("DecodeNativeAuth error = %v", err)
	}
}
