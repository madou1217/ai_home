package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestNewStaticAPIKeyAuthDerivesNodeCompatibleIdentity(t *testing.T) {
	secret := "sk-grok-secret-value-123"
	auth, err := NewStaticAPIKeyAuth(StaticAPIKeyInput{
		ProviderID: "grok",
		APIKey:     secret,
		BaseURL:    "HTTPS://API.X.AI:443/v1/",
	})
	if err != nil {
		t.Fatalf("NewStaticAPIKeyAuth() error = %v", err)
	}
	if auth.ProviderID() != "grok" {
		t.Fatalf("ProviderID() = %q", auth.ProviderID())
	}
	if auth.BaseURL() != "https://api.x.ai/v1" {
		t.Fatalf("BaseURL() = %q", auth.BaseURL())
	}
	digest := sha256.Sum256([]byte(secret))
	expectedFP := hex.EncodeToString(digest[:])[:16]
	expectedSeed := "api_key:grok:https://api.x.ai/v1:" + expectedFP
	if auth.IdentitySeed() != expectedSeed {
		t.Fatalf("IdentitySeed() = %q, want %q", auth.IdentitySeed(), expectedSeed)
	}
	if ref, err := DeriveAccountRef(auth); err != nil || !ref.IsValid() {
		t.Fatalf("DeriveAccountRef() = (%v, %v)", ref, err)
	}
	formatted := fmt.Sprintf("%s %v %#v", auth, auth, auth)
	if strings.Contains(formatted, secret) {
		t.Fatalf("formatted representation leaked secret: %q", formatted)
	}
}

func TestNewStaticAPIKeyAuthRejectsReservedAndInvalidInputs(t *testing.T) {
	for _, provider := range []string{"", "codex", "claude", "../bad"} {
		if _, err := NewStaticAPIKeyAuth(StaticAPIKeyInput{ProviderID: provider, APIKey: "sk-1"}); !errors.Is(err, ErrInvalidStaticAPIKey) {
			t.Fatalf("provider %q expected ErrInvalidStaticAPIKey, got %v", provider, err)
		}
	}
	for _, key := range []string{"", " sk-1", "sk-1\n"} {
		if _, err := NewStaticAPIKeyAuth(StaticAPIKeyInput{ProviderID: "kimi", APIKey: key}); !errors.Is(err, ErrInvalidStaticAPIKey) {
			t.Fatalf("key %q expected ErrInvalidStaticAPIKey, got %v", key, err)
		}
	}
	for _, baseURL := range []string{"ftp://bad", "https://user:pass@x.ai", "https://x.ai/v1?a=1"} {
		if _, err := NewStaticAPIKeyAuth(StaticAPIKeyInput{ProviderID: "kimi", APIKey: "sk-1", BaseURL: baseURL}); !errors.Is(err, ErrInvalidStaticBaseURL) {
			t.Fatalf("baseURL %q expected ErrInvalidStaticBaseURL, got %v", baseURL, err)
		}
	}
}
