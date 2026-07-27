package codex

import (
	"errors"
	"strings"
	"testing"
)

func TestNewAccountProfileKeepsOnlyCodexPublicMetadata(t *testing.T) {
	t.Parallel()

	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken:  testAccessSecret,
		RefreshToken: testRefreshSecret,
		IDToken: buildTestJWT(map[string]any{
			"sub":   "codex-profile-user",
			"email": "owner@example.com",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_account_id":         "codex-profile-workspace",
				"chatgpt_plan_type":          "team",
				"chatgpt_account_is_fedramp": true,
			},
		}),
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	profile, err := NewAccountProfile(auth.Profile())
	if err != nil {
		t.Fatalf("NewAccountProfile() error = %v", err)
	}
	if !profile.IsValid() ||
		profile.ProviderID() != ProviderID ||
		profile.IdentitySeed() != auth.IdentitySeed() ||
		profile.UserID() != "codex-profile-user" ||
		profile.AccountID() != "codex-profile-workspace" ||
		profile.Email() != "owner@example.com" ||
		profile.SubscriptionKind() != PlanFamilyBusiness.String() ||
		profile.SubscriptionRaw() != "team" ||
		!profile.IsFedRAMP() {
		t.Fatalf("AccountProfile 字段错误: %#v", profile)
	}
	if profile.DisplayName() != "" {
		t.Fatalf("Codex display name = %q, want empty", profile.DisplayName())
	}
}

func TestNewAccountProfileRejectsNonCanonicalMetadata(t *testing.T) {
	t.Parallel()

	tests := []Profile{
		{UserID: " user", AccountID: PersonalAccountID},
		{UserID: "user", AccountID: "workspace:bad"},
		{
			UserID:    "user",
			AccountID: PersonalAccountID,
			Email:     strings.Repeat("x", maxAccountProfileEmailLength+1),
		},
		{
			UserID:    "user",
			AccountID: PersonalAccountID,
			Plan:      ParsePlan(strings.Repeat("x", maxAccountProfileSubscriptionLength+1)),
		},
	}
	for _, input := range tests {
		if _, err := NewAccountProfile(input); !errors.Is(err, ErrInvalidAccountProfile) {
			t.Fatalf("NewAccountProfile(%#v) error = %v", input, err)
		}
	}
}
