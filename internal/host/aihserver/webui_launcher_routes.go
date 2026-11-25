package aihserver

import (
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/transport/http/webuilauncherapi"
)

// launcherRuntime owns the AIH Launch application service wired into aihserver.
type launcherRuntime struct {
	service *launcher.Service
}

// newLauncherRuntime wires the platform app catalog, launcher opener, usage store, and HTTP routes.
func newLauncherRuntime(dependencies webuiRouteDependencies) (*launcherRuntime, []webuiRoute, error) {
	store, err := launcherstore.New(dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, err
	}
	catalog := appcatalog.New()
	opener := applaunch.New()
	service, err := launcher.NewService(catalog, opener, store, time.Now)
	if err != nil {
		return nil, nil, err
	}
	handler, err := webuilauncherapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		return nil, nil, err
	}
	routes := []webuiRoute{
		{Pattern: webuilauncherapi.Path + "/apps", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuilauncherapi.Path + "/open", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuilauncherapi.Path + "/status", Handler: handler, SkipPublicAlias: true},
	}
	return &launcherRuntime{service: service}, routes, nil
}
