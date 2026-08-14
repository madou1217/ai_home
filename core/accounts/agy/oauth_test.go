package agy

import (
	"fmt"
	"strings"
	"testing"
)

func TestOAuthAuthPreservesStableEmailIdentityAcrossTokenRotation(t *testing.T) {
	t.Parallel()

	first := mustOAuth(t, OAuthInput{
		Email:         "User@Example.com",
		AccessToken:   "agy-access-secret-one",
		RefreshToken:  "agy-refresh-secret-one",
		ExpiresAtMS:   2_000_000_000_000,
		RefreshedAtMS: 1_900_000_000_000,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	})
	rotated := mustOAuth(t, OAuthInput{
		Email:         "user@example.com",
		AccessToken:   "agy-access-secret-two",
		RefreshToken:  "agy-refresh-secret-two",
		ExpiresAtMS:   2_100_000_000_000,
		RefreshedAtMS: 2_000_000_000_000,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	})

	if first.ProviderID() != ProviderID || first.Kind() != AuthKindOAuth {
		t.Fatalf("provider/kind = %q/%q", first.ProviderID(), first.Kind())
	}
	if first.Email() != "user@example.com" ||
		first.IdentitySeed() != "oauth:agy:user@example.com" ||
		rotated.IdentitySeed() != first.IdentitySeed() {
		t.Fatalf(
			"email/identity = %q/%q rotated=%q",
			first.Email(),
			first.IdentitySeed(),
			rotated.IdentitySeed(),
		)
	}
	if first.AccessToken() != "agy-access-secret-one" ||
		first.RefreshToken() != "agy-refresh-secret-one" ||
		first.ExpiresAtMS() != 2_000_000_000_000 ||
		first.RefreshedAtMS() != 1_900_000_000_000 ||
		first.TokenType() != "Bearer" ||
		first.AuthMethod() != AuthMethodConsumer {
		t.Fatal("OAuth 字段没有无损保留")
	}
}

func TestOAuthAuthSafeFormattingNeverLeaksTokens(t *testing.T) {
	t.Parallel()

	auth := mustOAuth(t, OAuthInput{
		Email:         "safe@example.com",
		AccessToken:   "agy-access-must-not-leak",
		RefreshToken:  "agy-refresh-must-not-leak",
		ExpiresAtMS:   2_000_000_000_000,
		RefreshedAtMS: 1_900_000_000_000,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	})

	formatted := fmt.Sprintf("%s %v %+v %#v", auth, auth, auth, auth)
	for _, secret := range []string{auth.AccessToken(), auth.RefreshToken()} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("安全格式化泄漏 secret: %q", formatted)
		}
	}
	if !strings.Contains(formatted, ProviderID) ||
		!strings.Contains(formatted, "safe@example.com") {
		t.Fatalf("安全摘要缺少稳定非敏感字段: %q", formatted)
	}
}

func TestOAuthAuthRejectsIncompleteOrUnstableIdentity(t *testing.T) {
	t.Parallel()

	valid := OAuthInput{
		Email:         "user@example.com",
		AccessToken:   "agy-access-secret",
		RefreshToken:  "agy-refresh-secret",
		ExpiresAtMS:   2_000_000_000_000,
		RefreshedAtMS: 1_900_000_000_000,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	}
	tests := []struct {
		name   string
		mutate func(*OAuthInput)
	}{
		{name: "missing email", mutate: func(input *OAuthInput) { input.Email = "" }},
		{name: "invalid email", mutate: func(input *OAuthInput) { input.Email = "not-an-email" }},
		{name: "missing access", mutate: func(input *OAuthInput) { input.AccessToken = "" }},
		{name: "missing refresh", mutate: func(input *OAuthInput) { input.RefreshToken = "" }},
		{name: "invalid expiry", mutate: func(input *OAuthInput) { input.ExpiresAtMS = 0 }},
		{name: "expiry before refresh", mutate: func(input *OAuthInput) { input.ExpiresAtMS = input.RefreshedAtMS }},
		{name: "invalid token type", mutate: func(input *OAuthInput) { input.TokenType = "Bearer\nsecret" }},
		{name: "invalid auth method", mutate: func(input *OAuthInput) { input.AuthMethod = "oauth" }},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := valid
			test.mutate(&input)
			if auth, err := NewOAuthAuth(input); err == nil || auth != nil {
				t.Fatalf("NewOAuthAuth() = %#v, %v", auth, err)
			}
		})
	}
}

func mustOAuth(t *testing.T, input OAuthInput) *OAuthAuth {
	t.Helper()
	auth, err := NewOAuthAuth(input)
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}
