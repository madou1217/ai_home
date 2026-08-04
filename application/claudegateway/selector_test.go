package claudegateway_test

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/claudegateway"
	"github.com/madou1217/ai_home/application/clauderelay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/providers"
)

const selectorModel = "claude-opus-5"

// TestSelectorSharesFairRecruitmentAcrossNativeAndCanonical 验证混合账号池
// 使用同一公平票号，并只为官方 OAuth 签发模型绑定租约。
func TestSelectorSharesFairRecruitmentAcrossNativeAndCanonical(t *testing.T) {
	t.Parallel()

	fixture := newSelectorFixture(t)
	first, err := fixture.selector.Select(t.Context(), claudegateway.Request{
		ModelID: selectorModel,
	})
	if err != nil {
		t.Fatalf("Select(first) error = %v", err)
	}
	second, err := fixture.selector.Select(t.Context(), claudegateway.Request{
		ModelID: selectorModel,
	})
	if err != nil {
		t.Fatalf("Select(second) error = %v", err)
	}
	lease, leased := first.Lease()
	resolvedAccount, resolvedModel, consumed := fixture.leases.ConsumeRelayToken(
		lease.Token(),
	)
	if !first.IsValid() || !second.IsValid() ||
		first.Transport() != claudegateway.TransportNativeOAuth ||
		first.AccountRef() != fixture.oauthRef ||
		!leased || lease.ModelID().String() != selectorModel ||
		!consumed || resolvedAccount != fixture.oauthRef ||
		resolvedModel.String() != selectorModel ||
		second.Transport() != claudegateway.TransportCanonical ||
		second.AccountRef() != fixture.apiKeyRef {
		t.Fatalf(
			"first=%v/%s leased=%t consumed=%t second=%v/%s",
			first.Transport(),
			first.AccountRef(),
			leased,
			consumed,
			second.Transport(),
			second.AccountRef(),
		)
	}
}

// TestSelectorHonorsPinnedAccountWithoutChangingCredentialTransport 验证固定账号
// 仍经过模型倒排、运行态和凭据策略，但不会回退到池内 OAuth 账号。
func TestSelectorHonorsPinnedAccountWithoutChangingCredentialTransport(
	t *testing.T,
) {
	t.Parallel()

	fixture := newSelectorFixture(t)
	decision, err := fixture.selector.Select(t.Context(), claudegateway.Request{
		ModelID:    selectorModel,
		AccountRef: fixture.apiKeyRef,
	})
	if err != nil {
		t.Fatalf("Select(pinned) error = %v", err)
	}
	if decision.Transport() != claudegateway.TransportCanonical ||
		decision.AccountRef() != fixture.apiKeyRef {
		t.Fatalf(
			"decision=%s/%s",
			decision.Transport(),
			decision.AccountRef(),
		)
	}
	if _, err := fixture.selector.Select(t.Context(), claudegateway.Request{
		ModelID:    selectorModel,
		AccountRef: "acct_ffffffffffffffffffff",
	}); !errors.Is(err, accountrouting.ErrNoRoutableAccount) {
		t.Fatalf("Select(missing pinned) error = %v", err)
	}
}

type selectorFixture struct {
	selector  *claudegateway.Selector
	leases    *clauderelay.LeaseRegistry
	oauthRef  accountcore.AccountRef
	apiKeyRef accountcore.AccountRef
}

// newSelectorFixture 创建一个 OAuth 与 API Key 各一个的真实 Recruiter 快照。
func newSelectorFixture(t *testing.T) selectorFixture {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	oauth, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-selector-oauth",
		RefreshToken: "sk-ant-ort01-selector-oauth",
		ExpiresAtMS:  time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(),
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-selector-api-key",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	credentials := []accountapp.Credential{oauth, apiKey}
	accounts := make([]accountapp.RoutingAccount, 0, len(credentials))
	bindings := make(map[accountcore.AccountRef]accountapp.CredentialBinding)
	for index, credential := range credentials {
		accountRef, deriveErr := accountcore.DeriveAccountRef(credential)
		if deriveErr != nil {
			t.Fatalf("DeriveAccountRef(%d) error = %v", index, deriveErr)
		}
		cliID, cliErr := accountcore.NewCLIAccountID(int64(index + 1))
		if cliErr != nil {
			t.Fatalf("NewCLIAccountID(%d) error = %v", index, cliErr)
		}
		account, accountErr := accountapp.NewRoutingAccount(
			catalog,
			accountapp.RoutingAccountInput{
				Ref:          accountRef,
				ProviderID:   claudeauth.ProviderID,
				CLIAccountID: cliID,
			},
		)
		if accountErr != nil {
			t.Fatalf("NewRoutingAccount(%d) error = %v", index, accountErr)
		}
		binding, bindingErr := accountapp.NewCredentialBinding(
			accountRef,
			claudeauth.ProviderID,
			credential,
		)
		if bindingErr != nil {
			t.Fatalf("NewCredentialBinding(%d) error = %v", index, bindingErr)
		}
		accounts = append(accounts, account)
		bindings[accountRef] = binding
	}
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates: selectorCandidates{
			accounts: accountapp.NewRoutingCandidates(accounts),
		},
		Runtime:     selectorRuntime{},
		Credentials: selectorCredentials{bindings: bindings},
	})
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	random := bytes.Repeat([]byte{0x5a}, 32*8)
	leases, err := clauderelay.NewLeaseRegistry(clauderelay.Dependencies{
		Random: bytes.NewReader(random),
		Clock: func() time.Time {
			return time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
		},
		TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("clauderelay.NewLeaseRegistry() error = %v", err)
	}
	selector, err := claudegateway.NewSelector(claudegateway.Dependencies{
		Catalog:    catalog,
		Recruiter:  recruiter,
		Transports: selectorTransportPolicy{},
		Leases:     leases,
	})
	if err != nil {
		t.Fatalf("claudegateway.NewSelector() error = %v", err)
	}
	return selectorFixture{
		selector:  selector,
		leases:    leases,
		oauthRef:  accounts[0].Ref(),
		apiKeyRef: accounts[1].Ref(),
	}
}

type selectorCandidates struct {
	accounts *accountapp.RoutingCandidates
}

func (source selectorCandidates) LoadRoutingCandidates(
	ctx context.Context,
	providerID string,
	modelID runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if providerID != claudeauth.ProviderID || modelID.String() != selectorModel {
		return accountapp.NewRoutingCandidates(nil), nil
	}
	return source.accounts, nil
}

type selectorRuntime struct{}

func (selectorRuntime) CheckEligibility(
	ctx context.Context,
	_ runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if err := ctx.Err(); err != nil {
		return runtimecore.Eligibility{}, err
	}
	return runtimecore.AvailableEligibility(), nil
}

type selectorCredentials struct {
	bindings map[accountcore.AccountRef]accountapp.CredentialBinding
}

func (resolver selectorCredentials) ResolveCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	if err := ctx.Err(); err != nil {
		return accountapp.CredentialBinding{}, err
	}
	binding, found := resolver.bindings[accountRef]
	if !found {
		return accountapp.CredentialBinding{}, accountapp.ErrCredentialNotFound
	}
	return binding, nil
}

type selectorTransportPolicy struct{}

func (selectorTransportPolicy) SupportsCredential(
	credential accountapp.Credential,
) bool {
	_, oauth := credential.(*claudeauth.OAuthAuth)
	_, apiKey := credential.(*claudeauth.APIKeyAuth)
	return oauth || apiKey
}

func (selectorTransportPolicy) TransportFor(
	credential accountapp.Credential,
) (claudegateway.Transport, error) {
	switch credential.(type) {
	case *claudeauth.OAuthAuth:
		return claudegateway.TransportNativeOAuth, nil
	case *claudeauth.APIKeyAuth:
		return claudegateway.TransportCanonical, nil
	default:
		return "", claudegateway.ErrInvalidTransport
	}
}
