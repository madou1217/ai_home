package aihserver

import (
	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountbrowserliveapi"
)

// Live surfaces remain separate from account profiles until true persistent
// multi-account browser isolation and proxy semantics have been demonstrated.
func buildWebUIAccountBrowserLiveRoutes(deps webuiRouteDependencies) ([]webuiRoute, error) {
	if deps.Authorizer == nil || deps.AIHomeDir == "" {
		return nil, nil
	}
	handler, err := webuiaccountbrowserliveapi.NewHandler(webuiaccountbrowserliveapi.Dependencies{
		Authorizer: deps.Authorizer, Runtime: accountbrowserview.New(accountbrowserview.Options{AIHomeDir: deps.AIHomeDir}),
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
