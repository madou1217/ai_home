package accounts

import (
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestEditCodexKeepsCurrentSecretAndBaseURL(t *testing.T) {
	current, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-old",
		BaseURL: "https://old.example/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := replacementForEdit(current, StaticCredentialEdit{})
	if err != nil {
		t.Fatal(err)
	}
	next, ok := replacement.(*codex.APIKeyAuth)
	if !ok {
		t.Fatalf("replacement type = %T", replacement)
	}
	if next.APIKey() != "sk-old" || next.BaseURL() != "https://old.example/v1" {
		t.Fatalf("replacement = %s/%s", next.APIKey(), next.BaseURL())
	}
}

func TestEditCodexAppliesNewSecretAndBaseURL(t *testing.T) {
	current, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-old",
		BaseURL: "https://old.example/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := replacementForEdit(current, StaticCredentialEdit{
		APIKey:         "sk-new",
		BaseURL:        "https://new.example/v1",
		IncludeBaseURL: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	next := replacement.(*codex.APIKeyAuth)
	if next.APIKey() != "sk-new" || next.BaseURL() != "https://new.example/v1" {
		t.Fatalf("replacement = %s/%s", next.APIKey(), next.BaseURL())
	}
}

func TestEditClaudeSwitchesKindOnlyWithNewSecret(t *testing.T) {
	current, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  "sk-ant-old",
		BaseURL: "https://old.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := replacementForEdit(current, StaticCredentialEdit{AuthKind: "auth-token"}); !errors.Is(err, ErrStaticCredentialEditIncomplete) {
		t.Fatalf("expected incomplete edit, got %v", err)
	}
	replacement, err := replacementForEdit(current, StaticCredentialEdit{
		APIKey:         "tok-new",
		AuthKind:       "auth-token",
		BaseURL:        "https://new.example",
		IncludeBaseURL: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	next, ok := replacement.(*claude.AuthTokenAuth)
	if !ok {
		t.Fatalf("replacement type = %T", replacement)
	}
	if next.AuthToken() != "tok-new" || next.BaseURL() != "https://new.example" {
		t.Fatalf("replacement = %s/%s", next.AuthToken(), next.BaseURL())
	}
}

func TestEditClaudeAuthTokenKeepsCurrentToken(t *testing.T) {
	current, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: "tok-old",
		BaseURL:   "https://old.example",
	})
	if err != nil {
		t.Fatal(err)
	}
	replacement, err := replacementForEdit(current, StaticCredentialEdit{})
	if err != nil {
		t.Fatal(err)
	}
	next := replacement.(*claude.AuthTokenAuth)
	if next.AuthToken() != "tok-old" || next.BaseURL() != "https://old.example" {
		t.Fatalf("replacement = %s/%s", next.AuthToken(), next.BaseURL())
	}
}

func TestEditCodexRejectsAuthTokenKind(t *testing.T) {
	current, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-old"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := replacementForEdit(current, StaticCredentialEdit{AuthKind: "auth-token"}); !errors.Is(err, ErrStaticCredentialRotationUnsupported) {
		t.Fatalf("expected unsupported, got %v", err)
	}
}
