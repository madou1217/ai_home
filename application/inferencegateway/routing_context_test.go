package inferencegateway_test

import (
	"context"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestPinnedAccountContextKeepsValidatedRequestScope 验证固定账号只存在于派生 Context。
func TestPinnedAccountContextKeepsValidatedRequestScope(t *testing.T) {
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	parent := context.Background()
	ctx, err := inferencegateway.WithPinnedAccount(parent, accountRef)
	if err != nil {
		t.Fatalf("WithPinnedAccount() error = %v", err)
	}
	if _, found := inferencegateway.PinnedAccount(parent); found {
		t.Fatal("固定账号污染了父 Context")
	}
	got, found := inferencegateway.PinnedAccount(ctx)
	if !found || got != accountRef {
		t.Fatalf("PinnedAccount() = %s, %t", got, found)
	}
	if _, err := inferencegateway.WithPinnedAccount(parent, "invalid"); !errors.Is(
		err,
		inferencegateway.ErrInvalidPinnedAccount,
	) {
		t.Fatalf("WithPinnedAccount(invalid) error = %v", err)
	}
}
