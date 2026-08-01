package accounts_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestCredentialSnapshotPreservesIdentityAndVersion 验证快照保留身份与毫秒版本。
func TestCredentialSnapshotPreservesIdentityAndVersion(t *testing.T) {
	t.Parallel()

	credential := snapshotTestCredential{
		providerID:   "codex",
		identitySeed: "oauth:codex:snapshot-user",
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	version := time.Date(2026, 7, 27, 12, 0, 0, 123_000_000, time.UTC)

	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.ProviderID(),
		credential,
		version,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	if snapshot.AccountRef() != accountRef ||
		snapshot.Credential().IdentitySeed() != credential.IdentitySeed() ||
		!snapshot.UpdatedAt().Equal(version) ||
		!snapshot.IsValid() {
		t.Fatalf("CredentialSnapshot = %#v", snapshot)
	}
}

// TestCredentialReplacementRejectsIdentityDriftAndStaleVersion 验证替换不能改变身份或回退版本。
func TestCredentialReplacementRejectsIdentityDriftAndStaleVersion(t *testing.T) {
	t.Parallel()

	currentCredential := snapshotTestCredential{
		providerID:   "claude",
		identitySeed: "oauth:claude:stable-account",
	}
	accountRef, err := accountcore.DeriveAccountRef(currentCredential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	currentVersion := time.Date(2026, 7, 27, 12, 0, 0, 0, time.UTC)
	current, err := accountapp.NewCredentialSnapshot(
		accountRef,
		currentCredential.ProviderID(),
		currentCredential,
		currentVersion,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}

	tests := []struct {
		name       string
		credential accountapp.Credential
		updatedAt  time.Time
	}{
		{
			name: "身份变化",
			credential: snapshotTestCredential{
				providerID:   "claude",
				identitySeed: "oauth:claude:other-account",
			},
			updatedAt: currentVersion.Add(time.Millisecond),
		},
		{
			name:       "版本未推进",
			credential: currentCredential,
			updatedAt:  currentVersion,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, replacementErr := accountapp.NewCredentialReplacement(
				current,
				test.credential,
				test.updatedAt,
			)
			if !errors.Is(
				replacementErr,
				accountapp.ErrInvalidCredentialReplacement,
			) {
				t.Fatalf(
					"NewCredentialReplacement() error = %v",
					replacementErr,
				)
			}
		})
	}
}

// snapshotTestCredential 是快照值对象测试使用的无敏感凭据。
type snapshotTestCredential struct {
	providerID   string
	identitySeed string
}

// ProviderID 返回测试凭据的规范 Provider。
func (credential snapshotTestCredential) ProviderID() string {
	return credential.providerID
}

// IdentitySeed 返回测试凭据的稳定身份种子。
func (credential snapshotTestCredential) IdentitySeed() string {
	return credential.identitySeed
}

// String 返回不含身份种子的安全测试摘要。
func (credential snapshotTestCredential) String() string {
	return fmt.Sprintf(
		"snapshotTestCredential{%s}",
		credential.providerID,
	)
}

// GoString 复用安全测试摘要。
func (credential snapshotTestCredential) GoString() string {
	return credential.String()
}
