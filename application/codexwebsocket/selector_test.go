package codexwebsocket_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// TestSelectorResolvesExactRouteAndReusesRecruiter 验证选择器不构造 Canonical
// Request，并把同一个真实模型交给统一账号 Recruiter。
func TestSelectorResolvesExactRouteAndReusesRecruiter(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	route := newCodexRoute(t, "gpt-5.6-sol")
	credential := newCodexCredential(t)
	account := newRoutingAccount(t)
	routes := &routeResolverStub{route: route}
	recruiter := &recruiterStub{
		result: newRecruitmentResult(t, catalog, account, credential),
	}
	selector, err := codexwebsocket.NewSelector(codexwebsocket.Dependencies{
		Catalog:    catalog,
		Routes:     routes,
		Recruiter:  recruiter,
		Transports: credentialPolicyStub{},
	})
	if err != nil {
		t.Fatalf("NewSelector() error = %v", err)
	}

	selection, err := selector.Select(context.Background(), codexwebsocket.Request{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "gpt-5.6-sol",
	})
	if err != nil {
		t.Fatalf("Select() error = %v", err)
	}
	if !selection.IsValid() ||
		selection.Route() != route ||
		selection.AccountRef() != account.Ref() ||
		selection.Credential() != credential ||
		!selection.CredentialObservation().IsValid() ||
		selection.CredentialObservation().AccountRef() != account.Ref() {
		t.Fatalf("selection = %#v", selection)
	}
	if routes.model != "gpt-5.6-sol" ||
		routes.provider != inference.ProviderCodex ||
		routes.protocol != inference.ProtocolCodexResponses ||
		recruiter.model != "gpt-5.6-sol" {
		t.Fatalf("route query=%#v recruiter model=%q", routes, recruiter.model)
	}
}

// TestSelectorRejectsAliasRewrite 验证原生帧不会被悄悄改写成别名目标。
func TestSelectorRejectsAliasRewrite(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	selector, err := codexwebsocket.NewSelector(codexwebsocket.Dependencies{
		Catalog: catalog,
		Routes: &routeResolverStub{
			route: newCodexRoute(t, "gpt-5.6-sol"),
		},
		Recruiter:  &recruiterStub{},
		Transports: credentialPolicyStub{},
	})
	if err != nil {
		t.Fatalf("NewSelector() error = %v", err)
	}
	_, err = selector.Select(context.Background(), codexwebsocket.Request{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "codex-latest",
	})
	if !errors.Is(err, codexwebsocket.ErrModelRewriteRequired) {
		t.Fatalf("Select(alias) error = %v", err)
	}
}

type routeResolverStub struct {
	route    inferencegateway.Route
	model    string
	provider inference.ProviderID
	protocol inference.ProtocolID
}

func (resolver *routeResolverStub) ResolveProtocolRoute(
	_ context.Context,
	_ inference.ClientProtocolID,
	model string,
	provider inference.ProviderID,
	protocol inference.ProtocolID,
) (inferencegateway.Route, error) {
	resolver.model = model
	resolver.provider = provider
	resolver.protocol = protocol
	return resolver.route, nil
}

type recruiterStub struct {
	result accountrouting.Result
	model  string
}

func (recruiter *recruiterStub) Recruit(
	_ context.Context,
	request accountrouting.Request,
	_ accountrouting.CredentialTransportPolicy,
) (accountrouting.Result, error) {
	recruiter.model = request.ModelID().String()
	return recruiter.result, nil
}

type credentialPolicyStub struct{}

func (credentialPolicyStub) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return credential != nil && credential.ProviderID() == codexauth.ProviderID
}

func newProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newCodexRoute(
	t *testing.T,
	model string,
) inferencegateway.Route {
	t.Helper()
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	return route
}

func newCodexCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "synthetic-api-key",
		BaseURL: "https://upstream.example/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	return credential
}

func newRoutingAccount(t *testing.T) accountapp.RoutingAccount {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(
		"acct_0123456789abcdef0123",
	)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		newProviderCatalog(t),
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   codexauth.ProviderID,
			CLIAccountID: cliID,
		},
	)
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	return account
}

func newRecruitmentResult(
	t *testing.T,
	catalog *providers.Catalog,
	account accountapp.RoutingAccount,
	credential accountapp.Credential,
) accountrouting.Result {
	t.Helper()
	// Result 字段故意不导出；通过真实 Recruiter 构造可避免测试伪造跨层状态。
	candidates := accountapp.NewRoutingCandidates(
		[]accountapp.RoutingAccount{account},
	)
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates: routingCandidateSourceStub{candidates: candidates},
		Runtime:    eligibleRuntimeStub{},
		Credentials: credentialResolverStub{
			accountRef: account.Ref(),
			credential: credential,
		},
	})
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	request, err := accountrouting.NewRequest(
		catalog,
		codexauth.ProviderID,
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	result, err := recruiter.Recruit(
		context.Background(),
		request,
		credentialPolicyStub{},
	)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	return result
}

type routingCandidateSourceStub struct {
	candidates *accountapp.RoutingCandidates
}

func (source routingCandidateSourceStub) LoadRoutingCandidates(
	context.Context,
	string,
	runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	return source.candidates, nil
}

type eligibleRuntimeStub struct{}

func (eligibleRuntimeStub) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

type credentialResolverStub struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
}

func (resolver credentialResolverStub) ResolveCredentialBinding(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	return accountapp.NewCredentialBinding(
		resolver.accountRef,
		codexauth.ProviderID,
		resolver.credential,
	)
}

func (resolver credentialResolverStub) ResolveObservedCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
	error,
) {
	binding, err := resolver.ResolveCredentialBinding(ctx, accountRef)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		binding.AccountRef(),
		binding.ProviderID(),
		binding.Credential(),
		time.Date(2026, 8, 15, 7, 0, 0, 0, time.UTC),
	)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	return binding, observation, err
}
