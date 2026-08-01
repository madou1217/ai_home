package accounts_test

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestLaunchAccountSelectorResolvesExplicitAndDefaultTargets 验证三种启动输入具有唯一且可观察的选择来源。
func TestLaunchAccountSelectorResolvesExplicitAndDefaultTargets(t *testing.T) {
	t.Parallel()

	account := newManagementTestAccount(t)
	candidate := newLaunchCandidate(t, account, true)
	store := &launchSelectionStoreStub{candidate: candidate}
	selector, err := accountapp.NewLaunchAccountSelector(testCatalog(t), store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}

	tests := []struct {
		name       string
		request    accountapp.LaunchSelectionRequest
		wantSource accountapp.LaunchSelectionSource
		wantCall   string
	}{
		{
			name: "account ref",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: account.Ref(),
			},
			wantSource: accountapp.LaunchSelectionSourceAccountRef,
			wantCall:   "ref",
		},
		{
			name: "cli account id",
			request: accountapp.LaunchSelectionRequest{
				ProviderID:   "codex",
				CLIAccountID: account.CLIAccountID(),
			},
			wantSource: accountapp.LaunchSelectionSourceCLIAccountID,
			wantCall:   "alias",
		},
		{
			name:       "provider default",
			request:    accountapp.LaunchSelectionRequest{ProviderID: "codex"},
			wantSource: accountapp.LaunchSelectionSourceProviderDefault,
			wantCall:   "default",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store.reset()
			selection, err := selector.Resolve(context.Background(), test.request)
			if err != nil {
				t.Fatalf("Resolve() error = %v", err)
			}
			if !selection.IsValid() ||
				selection.Account() != account ||
				selection.Source() != test.wantSource ||
				store.call != test.wantCall ||
				store.calls != 1 {
				t.Fatalf(
					"selection=%#v source=%s call=%s calls=%d",
					selection.Account(),
					selection.Source(),
					store.call,
					store.calls,
				)
			}
		})
	}
}

// TestLaunchAccountSelectorRejectsInvalidAndIneligibleTargets 验证模糊输入和不合格账号均失败关闭。
func TestLaunchAccountSelectorRejectsInvalidAndIneligibleTargets(t *testing.T) {
	t.Parallel()

	account := newManagementTestAccount(t)
	disabled, err := account.WithEnabled(false, account.UpdatedAt().Add(time.Minute))
	if err != nil {
		t.Fatalf("WithEnabled(false) error = %v", err)
	}
	claudeAccount := newClaudeLaunchTestAccount(t)

	tests := []struct {
		name      string
		request   accountapp.LaunchSelectionRequest
		candidate accountapp.LaunchCandidate
		wantErr   error
		wantCalls int
	}{
		{
			name: "non canonical provider",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "Codex",
			},
			wantErr: accountapp.ErrInvalidLaunchSelection,
		},
		{
			name: "ambiguous explicit target",
			request: accountapp.LaunchSelectionRequest{
				ProviderID:   "codex",
				AccountRef:   account.Ref(),
				CLIAccountID: account.CLIAccountID(),
			},
			wantErr: accountapp.ErrInvalidLaunchSelection,
		},
		{
			name: "provider mismatch",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: claudeAccount.Ref(),
			},
			candidate: newLaunchCandidate(t, claudeAccount, true),
			wantErr:   accountapp.ErrLaunchSelectionProviderMismatch,
			wantCalls: 1,
		},
		{
			name: "disabled",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: disabled.Ref(),
			},
			candidate: newLaunchCandidate(t, disabled, true),
			wantErr:   accountapp.ErrLaunchSelectionDisabled,
			wantCalls: 1,
		},
		{
			name: "unconfigured",
			request: accountapp.LaunchSelectionRequest{
				ProviderID: "codex",
				AccountRef: account.Ref(),
			},
			candidate: newLaunchCandidate(t, account, false),
			wantErr:   accountapp.ErrLaunchSelectionUnconfigured,
			wantCalls: 1,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &launchSelectionStoreStub{candidate: test.candidate}
			selector, err := accountapp.NewLaunchAccountSelector(testCatalog(t), store)
			if err != nil {
				t.Fatalf("NewLaunchAccountSelector() error = %v", err)
			}
			if _, err := selector.Resolve(
				context.Background(),
				test.request,
			); !errors.Is(err, test.wantErr) {
				t.Fatalf("Resolve() error = %v, want %v", err, test.wantErr)
			}
			if store.calls != test.wantCalls {
				t.Fatalf("store calls = %d, want %d", store.calls, test.wantCalls)
			}
		})
	}
}

// TestLaunchAccountSelectorValidatesDependenciesAndPropagatesStoreError 验证依赖和读取错误不会被静默降级。
func TestLaunchAccountSelectorValidatesDependenciesAndPropagatesStoreError(t *testing.T) {
	t.Parallel()

	store := &launchSelectionStoreStub{err: accountapp.ErrAccountNotFound}
	if _, err := accountapp.NewLaunchAccountSelector(nil, store); !errors.Is(
		err,
		accountapp.ErrInvalidLaunchSelectionDependencies,
	) {
		t.Fatalf("NewLaunchAccountSelector(nil catalog) error = %v", err)
	}
	if _, err := accountapp.NewLaunchAccountSelector(testCatalog(t), nil); !errors.Is(
		err,
		accountapp.ErrInvalidLaunchSelectionDependencies,
	) {
		t.Fatalf("NewLaunchAccountSelector(nil store) error = %v", err)
	}
	selector, err := accountapp.NewLaunchAccountSelector(testCatalog(t), store)
	if err != nil {
		t.Fatalf("NewLaunchAccountSelector() error = %v", err)
	}
	if _, err := selector.Resolve(
		context.Background(),
		accountapp.LaunchSelectionRequest{ProviderID: "codex"},
	); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("Resolve(store error) = %v", err)
	}
}

// newLaunchCandidate 创建应用选择测试使用的紧凑资格投影。
func newLaunchCandidate(
	t *testing.T,
	account accountcore.Account,
	hasCredential bool,
) accountapp.LaunchCandidate {
	t.Helper()

	candidate, err := accountapp.NewLaunchCandidate(account, hasCredential)
	if err != nil {
		t.Fatalf("NewLaunchCandidate() error = %v", err)
	}
	return candidate
}

// newClaudeLaunchTestAccount 创建用于 Provider 不匹配测试的 Claude 账号。
func newClaudeLaunchTestAccount(t *testing.T) accountcore.Account {
	t.Helper()

	credential, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey: "launch-selection-claude-key",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(testCatalog(t), accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    time.Date(2026, time.August, 1, 8, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

// launchSelectionStoreStub 记录选择器使用的唯一读取分支。
type launchSelectionStoreStub struct {
	candidate accountapp.LaunchCandidate
	err       error
	call      string
	calls     int
}

func (store *launchSelectionStoreStub) LoadLaunchCandidateByRef(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.LaunchCandidate, error) {
	store.call = "ref"
	store.calls++
	return store.candidate, store.err
}

func (store *launchSelectionStoreStub) LoadLaunchCandidateByCLIAccountID(
	_ context.Context,
	_ string,
	_ accountcore.CLIAccountID,
) (accountapp.LaunchCandidate, error) {
	store.call = "alias"
	store.calls++
	return store.candidate, store.err
}

func (store *launchSelectionStoreStub) LoadDefaultLaunchCandidate(
	_ context.Context,
	_ string,
) (accountapp.LaunchCandidate, error) {
	store.call = "default"
	store.calls++
	return store.candidate, store.err
}

func (store *launchSelectionStoreStub) reset() {
	store.call = ""
	store.calls = 0
}
