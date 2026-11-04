package accountsapi

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestParseMemberResourceRecognizesRuntimeState(t *testing.T) {
	t.Parallel()
	resource, err := parseMemberResource(
		CollectionPath + "/acct_0123456789abcdef0123/runtime-state",
	)
	if err != nil {
		t.Fatalf("parseMemberResource() error = %v", err)
	}
	if resource.kind != memberResourceRuntimeState {
		t.Fatalf("kind = %v", resource.kind)
	}
}

func TestNewRuntimeStateViewDerivesStatus(t *testing.T) {
	t.Parallel()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref,
		Document:   []byte(`{"authInvalidUntil":60000,"lastFailureReason":"expired"}`),
		UpdatedAt:  time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountState() error = %v", err)
	}
	view := newRuntimeStateView(state, time.UnixMilli(20_000).UTC())
	if view.Status != "auth_invalid" || view.Reason != "expired" || view.UntilMS != 60_000 {
		t.Fatalf("view = %#v", view)
	}
	if len(view.State) == 0 || view.State[0] != '{' {
		t.Fatalf("state = %s", view.State)
	}

	healthy := newRuntimeStateView(state, time.UnixMilli(70_000).UTC())
	if healthy.Status != "healthy" || healthy.UntilMS != 0 {
		t.Fatalf("healthy view = %#v", healthy)
	}
}

func TestIsJSONNull(t *testing.T) {
	t.Parallel()
	for _, value := range []string{"", "null", " null "} {
		if !isJSONNull([]byte(value)) {
			t.Fatalf("isJSONNull(%q) = false", value)
		}
	}
	for _, value := range []string{"{}", "[]", "0"} {
		if isJSONNull([]byte(value)) {
			t.Fatalf("isJSONNull(%q) = true", value)
		}
	}
}
