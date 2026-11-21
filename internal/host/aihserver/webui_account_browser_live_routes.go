package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserliveapi"
)

type accountBrowserLiveScopeResolver struct {
	authority webuiaccountbrowserapi.Authority
	runtime   *accountbrowser.Service
	egress    *runtimeegress.Manager
}

func (r accountBrowserLiveScopeResolver) Resolve(ctx context.Context, request webuiaccountbrowserliveapi.ScopeRequest) (webuiaccountbrowserliveapi.Scope, error) {
	if request.Scope != webuiaccountbrowserliveapi.ScopeAccount || r.authority == nil || r.runtime == nil {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	identity, err := r.authority.Resolve(ctx, request.Provider, request.AccountRef)
	if err != nil {
		return webuiaccountbrowserliveapi.Scope{}, err
	}
	_, dataDir, _, err := r.runtime.EnsureDataDir(ctx, identity)
	if err != nil {
		return webuiaccountbrowserliveapi.Scope{}, err
	}
	scope := webuiaccountbrowserliveapi.Scope{Kind: webuiaccountbrowserliveapi.ScopeAccount, DataDir: dataDir}
	if r.egress == nil {
		return scope, nil
	}
	resolved, resolveErr := r.egress.ResolveAccountEgress(ctx, runtimeegress.ResolveAccountEgressOptions{
		Provider: request.Provider, AccountRef: request.AccountRef, SkipProbe: false,
	})
	if resolveErr != nil {
		return webuiaccountbrowserliveapi.Scope{}, resolveErr
	}
	if !resolved.Bound || resolved.Direct {
		return scope, nil
	}
	scope.ProxyRequired = true
	if !resolved.OK || resolved.ProxyServer == "" {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	scope.ProxyURL = resolved.ProxyServer
	return scope, nil
}

// Live surfaces keep task scope for the studio, while account scope is selected
// only after the server resolves Provider+accountRef and the durable profile.

func buildWebUIAccountBrowserLiveRoutes(deps webuiRouteDependencies) ([]webuiRoute, error) {
	if deps.Authorizer == nil || deps.AIHomeDir == "" {
		return nil, nil
	}
	runtime := accountbrowserview.New(accountbrowserview.Options{AIHomeDir: deps.AIHomeDir})
	profileRuntime, err := accountbrowser.NewService(accountbrowser.Options{AIHomeDir: deps.AIHomeDir})
	if err != nil {
		return nil, err
	}
	var scopeResolver webuiaccountbrowserliveapi.ScopeResolver
	if deps.Store != nil {
		authority := webuiaccountbrowserapi.AccountAuthority{
			Accounts: deps.Store,
			ServerID: func(ctx context.Context) (string, error) {
				return webuiaccountbrowserapi.ReadServerID(ctx, deps.AIHomeDir)
			},
		}
		scopeResolver = accountBrowserLiveScopeResolver{authority: authority, runtime: profileRuntime, egress: deps.EgressManager}
	}
	handler, err := webuiaccountbrowserliveapi.NewHandler(webuiaccountbrowserliveapi.Dependencies{
		Authorizer:    deps.Authorizer,
		Runtime:       runtime,
		ScopeResolver: scopeResolver,
	})
	if err != nil {
		return nil, err
	}
	return []webuiRoute{
		{Pattern: "GET " + webuiaccountbrowserliveapi.BasePath, Handler: handler},
		{Pattern: "GET " + webuiaccountbrowserliveapi.BasePath + "/capabilities", Handler: handler},
		{Pattern: "POST " + webuiaccountbrowserliveapi.BasePath + "/stream", Handler: handler},
		{Pattern: "POST " + webuiaccountbrowserliveapi.BasePath + "/command", Handler: handler},
	}, nil
}
