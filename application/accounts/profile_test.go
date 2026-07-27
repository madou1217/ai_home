package accounts_test

import (
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestProfileSnapshotDerivesStableAccountIdentity(t *testing.T) {
	t.Parallel()

	profile, err := codex.NewAccountProfile(codex.Profile{
		UserID:    "profile-user",
		AccountID: codex.PersonalAccountID,
		Email:     "profile@example.com",
		Plan:      codex.ParsePlan("plus"),
	})
	if err != nil {
		t.Fatalf("NewAccountProfile() error = %v", err)
	}
	capturedAt := time.Date(
		2026,
		time.July,
		27,
		15,
		30,
		0,
		123_999_999,
		time.FixedZone("CST", 8*60*60),
	)
	snapshot, err := accountapp.NewProfileSnapshot(testCatalog(t), profile, capturedAt)
	if err != nil {
		t.Fatalf("NewProfileSnapshot() error = %v", err)
	}
	expectedRef, err := accountcore.DeriveAccountRef(profile)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	expectedTime := time.Date(2026, time.July, 27, 7, 30, 0, 123_000_000, time.UTC)
	if snapshot.AccountRef() != expectedRef ||
		snapshot.Profile() != profile ||
		!snapshot.UpdatedAt().Equal(expectedTime) {
		t.Fatalf("ProfileSnapshot 字段错误: %#v", snapshot)
	}
}

func TestProfileSnapshotRejectsInvalidInputs(t *testing.T) {
	t.Parallel()

	for _, build := range []func() (accountapp.ProfileSnapshot, error){
		func() (accountapp.ProfileSnapshot, error) {
			return accountapp.NewProfileSnapshot(testCatalog(t), nil, time.Now())
		},
		func() (accountapp.ProfileSnapshot, error) {
			return accountapp.NewProfileSnapshot(
				testCatalog(t),
				codex.AccountProfile{},
				time.Now(),
			)
		},
	} {
		if _, err := build(); !errors.Is(err, accountapp.ErrInvalidProfile) {
			t.Fatalf("NewProfileSnapshot() error = %v, want ErrInvalidProfile", err)
		}
	}
}
