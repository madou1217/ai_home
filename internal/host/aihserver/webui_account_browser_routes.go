package aihserver

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowser"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserapi"
)

// buildWebUIAccountBrowserRoutes owns only composition. Profile lifecycle,
// account authority and HTTP handling remain independently scoped modules.
func buildWebUIAccountBrowserRoutes(deps webuiRouteDependencies) ([]webuiRoute, error) {
	if deps.Authorizer == nil || deps.Store == nil || deps.AIHomeDir == "" {
		return nil, nil
	}
	runtime, err := accountbrowser.NewService(accountbrowser.Options{AIHomeDir: deps.AIHomeDir})
	if err != nil {
		return nil, fmt.Errorf("create account browser runtime: %w", err)
	}
	authority := webuiaccountbrowserapi.AccountAuthority{
		Accounts: deps.Store,
		ServerID: func(ctx context.Context) (string, error) {
			return webuiaccountbrowserapi.ReadServerID(ctx, deps.AIHomeDir)
		},
	}
	handler, err := webuiaccountbrowserapi.NewHandler(webuiaccountbrowserapi.Dependencies{
		Authorizer: deps.Authorizer, Authority: authority, Runtime: runtime,
	})
	if err != nil {
		return nil, err
	}
	return []webuiRoute{
		{Pattern: "GET " + webuiaccountbrowserapi.CapabilitiesPath, Handler: handler},
		{Pattern: "GET " + webuiaccountbrowserapi.ProfilePath, Handler: handler},
		{Pattern: "POST " + webuiaccountbrowserapi.ProfilePath, Handler: handler},
		{Pattern: "POST " + webuiaccountbrowserapi.ProfilePath + "/open", Handler: handler},
		{Pattern: "POST " + webuiaccountbrowserapi.ProfilePath + "/close", Handler: handler},
	}, nil
}
