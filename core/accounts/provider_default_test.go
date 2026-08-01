package accounts_test

import (
	"errors"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestProviderDefaultNormalizesAndRestoresCanonicalValue 验证默认关系只保留稳定身份和毫秒时间。
func TestProviderDefaultNormalizesAndRestoresCanonicalValue(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	inputTime := time.Date(2026, time.August, 1, 10, 0, 0, 123_456_789, time.FixedZone("test", 8*60*60))
	providerDefault, err := accountcore.NewProviderDefault("codex", accountRef, inputTime)
	if err != nil {
		t.Fatalf("NewProviderDefault() error = %v", err)
	}
	wantTime := time.UnixMilli(inputTime.UnixMilli()).UTC()
	if !providerDefault.IsValid() ||
		providerDefault.ProviderID() != "codex" ||
		providerDefault.AccountRef() != accountRef ||
		!providerDefault.UpdatedAt().Equal(wantTime) {
		t.Fatalf("ProviderDefault = %#v, want canonical value", providerDefault)
	}
	restored, err := accountcore.RestoreProviderDefault("codex", accountRef, wantTime)
	if err != nil || restored != providerDefault {
		t.Fatalf("RestoreProviderDefault() = (%#v, %v)", restored, err)
	}
}

// TestProviderDefaultRejectsInvalidIdentityAndTime 验证默认关系不接受未知格式或非规范持久化时间。
func TestProviderDefaultRejectsInvalidIdentityAndTime(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	tests := []struct {
		name       string
		providerID string
		accountRef accountcore.AccountRef
		updatedAt  time.Time
		restore    bool
	}{
		{name: "非规范 Provider", providerID: "Codex", accountRef: accountRef, updatedAt: time.Now()},
		{name: "无效账号引用", providerID: "codex", updatedAt: time.Now()},
		{name: "零时间", providerID: "codex", accountRef: accountRef},
		{
			name:       "恢复非毫秒时间",
			providerID: "codex",
			accountRef: accountRef,
			updatedAt:  time.Date(2026, time.August, 1, 0, 0, 0, 1, time.UTC),
			restore:    true,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			var err error
			if test.restore {
				_, err = accountcore.RestoreProviderDefault(
					test.providerID,
					test.accountRef,
					test.updatedAt,
				)
			} else {
				_, err = accountcore.NewProviderDefault(
					test.providerID,
					test.accountRef,
					test.updatedAt,
				)
			}
			if err == nil || (!errors.Is(err, accountcore.ErrInvalidProviderDefault) &&
				!errors.Is(err, accountcore.ErrInvalidAccountTime)) {
				t.Fatalf("default error = %v", err)
			}
		})
	}
}
