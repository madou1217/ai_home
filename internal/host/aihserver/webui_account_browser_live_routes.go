package aihserver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/outboundproxy"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserliveapi"
)

type accountBrowserLiveScopeResolver struct {
	authority webuiaccountbrowserapi.Authority
	runtime   *accountbrowser.Service
	egress    *runtimeegress.Manager
	jobs      *accountauth.Service
	proxyPool *outboundproxy.Manager
	homeDir   string
}

// SupportsJobScope reports whether this host can resolve per-job OAuth browser
// profiles. New OAuth jobs have no accountRef until the callback creates the
// account, so the browser must not fall back to the shared task profile.
func (r accountBrowserLiveScopeResolver) SupportsJobScope() bool {
	return r.jobs != nil && r.homeDir != ""
}

func (r accountBrowserLiveScopeResolver) resolveJob(ctx context.Context, jobID string) (webuiaccountbrowserliveapi.Scope, error) {
	jobID = strings.TrimSpace(jobID)
	if len(jobID) < 8 || len(jobID) > 80 {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	for _, char := range jobID {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
		}
	}
	job, err := r.jobs.GetJob(ctx, jobID)
	if err != nil {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	if job.AuthMode() != "oauth-browser" || job.AccountRef() != "" {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	switch job.Status() {
	case accountauth.StatusPending, accountauth.StatusProcessing:
	default:
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	base := filepath.Join(r.homeDir, "run", "account-browser", "pending")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	dir := filepath.Join(base, jobID)
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
	}
	scope := webuiaccountbrowserliveapi.Scope{Kind: webuiaccountbrowserliveapi.ScopeJob, DataDir: dir}
	// A new account has no egress binding yet, but the authorize page may only
	// be reachable through the server's configured outbound proxy. Use the same
	// proxy pool the server uses for upstream calls; an empty pool stays direct.
	if r.proxyPool != nil {
		if proxyURL := strings.TrimSpace(r.proxyPool.Status().ProxyURL); proxyURL != "" {
			scope.ProxyURL = proxyURL
		}
	}
	return scope, nil
}

func (r accountBrowserLiveScopeResolver) Resolve(ctx context.Context, request webuiaccountbrowserliveapi.ScopeRequest) (webuiaccountbrowserliveapi.Scope, error) {
	if request.Scope == webuiaccountbrowserliveapi.ScopeJob {
		if r.jobs == nil || r.homeDir == "" {
			return webuiaccountbrowserliveapi.Scope{}, webuiaccountbrowserliveapi.ErrScopeUnavailable
		}
		return r.resolveJob(ctx, request.AuthJob)
	}
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
	// A brand-new OAuth account keeps the browser profile of the login job, so
	// the account browser opens with the session the user just established.
	if jobID, ok := accountbrowser.BoundJobProfile(r.homeDir, identity.Provider, identity.AccountRef); ok {
		pending := filepath.Join(r.homeDir, "run", "account-browser", "pending", jobID)
		if info, statErr := os.Lstat(pending); statErr == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			dataDir = pending
		}
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
		scopeResolver = accountBrowserLiveScopeResolver{authority: authority, runtime: profileRuntime, egress: deps.EgressManager, jobs: deps.AuthJobs, proxyPool: deps.ProxyPool, homeDir: deps.AIHomeDir}
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
