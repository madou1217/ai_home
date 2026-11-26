// Package worknative composes existing account launch strategies for WORK only.
// It does not infer account identity from inherited process credentials.
package worknative

import (
	"context"
	"net/http"
	"runtime"
	"strings"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
	runtimeprojection "github.com/madou1217/ai_home/internal/runtime/accountprojection"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

type Store interface {
	accountapp.LaunchSelectionStore
	accountapp.CredentialVersionStore
}

type Options struct {
	AIHomeDir, HostHomeDir, GatewayURL string
	GatewayKey                         func() string
	Catalog                            *providers.Catalog
	Store                              Store
	Credentials                        providerlaunch.CredentialResolver
}

type Service struct {
	opts       Options
	selector   *accountapp.LaunchAccountSelector
	planner    *providerlaunch.Planner
	projection appprojection.Provisioner
	strategies map[string]providerlaunch.Strategy
	gateways   map[string]providerlaunch.GatewayStrategy
}

var _ chatruntime.NativeLaunchPreparer = (*Service)(nil)

func New(opts Options) (*Service, error) {
	if opts.Catalog == nil || opts.Store == nil || opts.Credentials == nil || strings.TrimSpace(opts.HostHomeDir) == "" {
		return nil, chatruntime.NewError("native_launch_preparer_unavailable", http.StatusServiceUnavailable, nil)
	}
	selector, err := accountapp.NewLaunchAccountSelector(opts.Catalog, opts.Store)
	if err != nil {
		return nil, err
	}
	strategies, gateways, err := registeredStrategies()
	if err != nil {
		return nil, err
	}
	list := make([]providerlaunch.Strategy, 0, len(strategies))
	for _, strategy := range strategies {
		list = append(list, strategy)
	}
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{Accounts: selector, Credentials: opts.Credentials, Strategies: list})
	if err != nil {
		return nil, err
	}
	registry := providerstorage.New()
	projection, err := runtimeprojection.New(runtimeprojection.Options{AIHomeDir: opts.AIHomeDir, Policies: registry, Materializers: registry.Materializers(), Linker: runtimeprojection.NewLinker(), Credentials: opts.Store, HomeRoots: providerstorage.HomeRoots()})
	if err != nil {
		return nil, err
	}
	return &Service{opts: opts, selector: selector, planner: planner, projection: projection, strategies: strategies, gateways: gateways}, nil
}

// GetTarget exposes only low-sensitivity executable selection facts. It does
// not refresh credentials, write projection files or run a provider process.
func (s *Service) GetTarget(ctx context.Context, provider, ref string) (chatruntime.NativeExecutionDescriptor, error) {
	provider = sessionchat.NormalizeProvider(provider)
	ref = strings.TrimSpace(ref)
	if s == nil || ctx == nil {
		return chatruntime.NativeExecutionDescriptor{}, unavailable()
	}
	protocol, err := workProtocol(provider)
	if err != nil {
		return chatruntime.NativeExecutionDescriptor{}, err
	}
	if chatruntime.IsGatewayRuntimeScope(ref) {
		if _, ok := s.gateways[provider]; !ok {
			return chatruntime.NativeExecutionDescriptor{}, chatruntime.NewError("native_gateway_execution_unsupported", http.StatusUnprocessableEntity, nil)
		}
		if _, err := s.gatewayTarget(); err != nil {
			return chatruntime.NativeExecutionDescriptor{}, err
		}
		return chatruntime.NativeExecutionDescriptor{Mode: chatruntime.NativeExecutionGateway, Provider: provider, ClientProtocol: string(inference.ClientProtocolAnthropicMessages)}, nil
	}
	parsed, err := accountcore.ParseAccountRef(ref)
	if err != nil {
		return chatruntime.NativeExecutionDescriptor{}, chatruntime.NewError("native_account_required", http.StatusUnprocessableEntity, nil)
	}
	if _, err = s.selector.Resolve(ctx, accountapp.LaunchSelectionRequest{ProviderID: provider, AccountRef: parsed}); err != nil {
		return chatruntime.NativeExecutionDescriptor{}, selectionError(err)
	}
	strategy, ok := s.strategies[provider]
	if !ok {
		return chatruntime.NativeExecutionDescriptor{}, chatruntime.NewError("native_execution_provider_unsupported", http.StatusUnprocessableEntity, nil)
	}
	snapshot, err := s.opts.Store.GetCredentialSnapshot(ctx, parsed)
	if err != nil {
		return chatruntime.NativeExecutionDescriptor{}, unavailable()
	}
	binding, err := accountapp.NewCredentialBinding(parsed, provider, snapshot.Credential())
	if err != nil {
		return chatruntime.NativeExecutionDescriptor{}, unavailable()
	}
	built, err := strategy.Build(binding)
	if err != nil {
		return chatruntime.NativeExecutionDescriptor{}, chatruntime.NewError("native_credential_kind_unsupported", http.StatusUnprocessableEntity, nil)
	}
	if built.Runtime().Kind() != providerlaunch.RuntimeKindDirectProcess {
		return chatruntime.NativeExecutionDescriptor{}, chatruntime.NewError("native_execution_transport_unavailable", http.StatusNotImplemented, nil)
	}
	return chatruntime.NativeExecutionDescriptor{Mode: chatruntime.NativeExecutionAccountNative, Provider: provider, AccountRef: parsed.String(), ClientProtocol: protocol}, nil
}

func (s *Service) Prepare(ctx context.Context, req chatruntime.NativeLaunchRequest) (chatruntime.NativeLaunchPlan, error) {
	ref := req.Target.AccountRef
	if req.Target.Mode == chatruntime.NativeExecutionGateway {
		ref = chatruntime.GatewayRuntimeScope
	}
	current, err := s.GetTarget(ctx, req.Target.Provider, ref)
	if err != nil {
		return chatruntime.NativeLaunchPlan{}, err
	}
	if current != req.Target {
		return chatruntime.NativeLaunchPlan{}, chatruntime.NewError("native_execution_target_changed", http.StatusConflict, nil)
	}
	if current.Mode == chatruntime.NativeExecutionGateway {
		return s.prepareGateway(ctx, req)
	}
	parsed, _ := accountcore.ParseAccountRef(current.AccountRef)
	spec, err := s.planner.Build(ctx, accountapp.LaunchSelectionRequest{ProviderID: current.Provider, AccountRef: parsed})
	if err != nil {
		return chatruntime.NativeLaunchPlan{}, unavailable()
	}
	if spec.Runtime().Kind() != providerlaunch.RuntimeKindDirectProcess || !validWorkCommand(current.Provider, req.CommandName, spec.Binary()) || spec.AccountRef() != parsed {
		return chatruntime.NativeLaunchPlan{}, chatruntime.NewError("native_launch_binding_invalid", http.StatusConflict, nil)
	}
	args, err := spec.ResolveArguments(req.Args)
	if err != nil {
		return chatruntime.NativeLaunchPlan{}, err
	}
	env := scopedBase(s.opts.HostHomeDir)
	applyPatch(env, spec.Environment())
	env["AIH_PROVIDER_ACCOUNT_REF"] = parsed.String()
	plan := chatruntime.NativeLaunchPlan{Target: current, CommandName: req.CommandName, BinaryName: spec.Binary(), Args: args}
	if spec.Projection().Required() {
		request := appprojection.Request{ProviderID: current.Provider, AccountRef: parsed, Credential: spec.RevealCredential(), HostHomeDir: s.opts.HostHomeDir, AIHomeDir: s.opts.AIHomeDir, Platform: runtime.GOOS, Purpose: appprojection.PurposeLaunch, ProjectionRequired: true}
		projected, err := s.projection.Prepare(ctx, request)
		if err != nil {
			return chatruntime.NativeLaunchPlan{}, chatruntime.NewError("native_projection_unavailable", http.StatusServiceUnavailable, nil)
		}
		if projected.PolicyID != spec.Projection().PolicyID() || string(projected.Mode) != string(spec.Projection().Mode()) {
			return chatruntime.NativeLaunchPlan{}, chatruntime.NewError("native_projection_mismatch", http.StatusConflict, nil)
		}
		for _, name := range projected.UnsetEnv {
			delete(env, environmentKey(name))
		}
		for name, value := range projected.SetEnv {
			env[environmentKey(name)] = value
		}
		plan.Args = sessionchat.ApplyProviderConfigDirArgs(current.Provider, plan.Args, projected.Root)
		plan.Release = func(c context.Context) error { return s.projection.Capture(c, request, projected) }
	}
	plan.Env = environmentSlice(env)
	return plan, nil
}
