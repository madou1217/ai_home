package claude

import (
	"errors"
	"testing"
)

func TestNewAccountProfileCombinesOAuthProfileAndSubscription(t *testing.T) {
	t.Parallel()

	extraUsageEnabled := true
	oauth, err := NewOAuthProfile(OAuthProfileInput{
		AccountUUID:          "123e4567-e89b-12d3-a456-426614174000",
		Email:                "owner@example.com",
		OrganizationUUID:     "223e4567-e89b-12d3-a456-426614174000",
		OrganizationName:     "AI Home",
		OrganizationRole:     "admin",
		WorkspaceRole:        "developer",
		DisplayName:          "Owner",
		HasExtraUsageEnabled: &extraUsageEnabled,
		BillingType:          "stripe_subscription",
		AccountCreatedAtMS:   1_700_000_000_000,
	})
	if err != nil {
		t.Fatalf("NewOAuthProfile() error = %v", err)
	}
	subscription, err := NewSubscription("max", "default_claude_max_20x")
	if err != nil {
		t.Fatalf("NewSubscription() error = %v", err)
	}
	profile, err := NewAccountProfile(oauth, subscription)
	if err != nil {
		t.Fatalf("NewAccountProfile() error = %v", err)
	}
	if !profile.IsValid() ||
		profile.ProviderID() != ProviderID ||
		profile.IdentitySeed() != "oauth:claude:uuid:123e4567-e89b-12d3-a456-426614174000" ||
		profile.DisplayName() != "Owner" ||
		profile.Email() != "owner@example.com" ||
		profile.SubscriptionKind() != SubscriptionKindMax.String() ||
		profile.SubscriptionRaw() != "max" ||
		profile.Subscription().RateLimitTier() != "default_claude_max_20x" {
		t.Fatalf("AccountProfile 字段错误: %#v", profile)
	}
}

func TestNewAccountProfileRejectsZeroOAuthProfile(t *testing.T) {
	t.Parallel()

	subscription, err := NewSubscription("", "")
	if err != nil {
		t.Fatalf("NewSubscription() error = %v", err)
	}
	if _, err := NewAccountProfile(
		OAuthProfile{},
		subscription,
	); !errors.Is(err, ErrInvalidAccountProfile) {
		t.Fatalf("NewAccountProfile() error = %v, want ErrInvalidAccountProfile", err)
	}
}
