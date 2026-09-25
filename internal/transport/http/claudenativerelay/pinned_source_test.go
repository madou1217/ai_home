package claudenativerelay

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// TestPinnedRelayUsesOnlyThePinnedClaudeAccount 防回归：无租约请求带 x-account-ref 时，
// 透传只能用钉选账号；钉选的不是可解析的 claude 账号（如 agy）时报告无可透传账号，交回
// Canonical（生产实测：钉到 agy 的 claude-sonnet-4-6 被调度器改派给了 claude 账号）。
func TestPinnedRelayUsesOnlyThePinnedClaudeAccount(t *testing.T) {
	t.Parallel()

	claudeRef, credential := newRelayOAuthCredential(t)
	handler := &Handler{
		authorizer:  noLeaseAuthorizer{},
		credentials: &relayCredentialResolver{accountRef: claudeRef, credential: credential},
		accounts:    unexpectedSchedulerSource{t: t},
	}
	model := runtimecore.ModelID("claude-sonnet-4-6")

	pinned := httptest.NewRequest("POST", Path, nil)
	pinned.Header.Set(inferenceapi.AccountRefHeader, claudeRef.String())
	source, leased := handler.resolveAccountSource(pinned)
	if leased {
		t.Fatal("a pin is not a relay lease")
	}
	cursor, err := source.Accounts(context.Background(), model)
	if err != nil {
		t.Fatalf("pinned claude account: %v", err)
	}
	if ref, ok, _ := cursor.Next(context.Background()); !ok || ref != claudeRef {
		t.Fatalf("cursor = %v %v", ref, ok)
	}
	if _, ok, _ := cursor.Next(context.Background()); ok {
		t.Fatal("pinned cursor must yield exactly one account")
	}

	other := httptest.NewRequest("POST", Path, nil)
	other.Header.Set(inferenceapi.AccountRefHeader, "acct_03f68577e90ee8c1f577")
	source, _ = handler.resolveAccountSource(other)
	if _, err := source.Accounts(context.Background(), model); !errors.Is(err, ErrNoRelayAccount) {
		t.Fatalf("non-claude pin must be handed to Canonical, got %v", err)
	}

	invalid := httptest.NewRequest("POST", Path, nil)
	invalid.Header.Set(inferenceapi.AccountRefHeader, "not-a-ref")
	source, _ = handler.resolveAccountSource(invalid)
	if _, err := source.Accounts(context.Background(), model); !errors.Is(err, ErrNoRelayAccount) {
		t.Fatalf("invalid pin must be handed to Canonical, got %v", err)
	}
}

// unexpectedSchedulerSource 断言钉选请求绝不回退到调度器。
type unexpectedSchedulerSource struct{ t *testing.T }

func (source unexpectedSchedulerSource) Accounts(context.Context, runtimecore.ModelID) (AccountCursor, error) {
	source.t.Fatal("pinned requests must not use the scheduler")
	return nil, nil
}

// noLeaseAuthorizer 模拟不带 Relay Token 的普通客户端。
type noLeaseAuthorizer struct{}

func (noLeaseAuthorizer) Authorize(*http.Request) (accountcore.AccountRef, runtimecore.ModelID, bool) {
	return "", "", false
}
