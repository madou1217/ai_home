package aihserver

import (
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/managementstatusapi"
)

type managementStatusSource struct {
	catalog  *providers.Catalog
	store    *sqliteaccount.Store
	status   func() catalogReadiness
	strategy accountrouting.SelectionStrategy
}

func (source managementStatusSource) Snapshot() managementstatusapi.Snapshot {
	status := catalogReadiness{}
	if source.status != nil {
		status = source.status()
	}
	accounts := status.accounts
	if accounts == nil {
		accounts = accountCountsByProvider(source.catalog, source.store)
	}
	return managementstatusapi.Snapshot{
		Backend:               "go-core",
		ProviderMode:          "account-pool",
		Strategy:              string(source.strategy),
		Accounts:              accounts,
		ModelCount:            status.modelCount,
		RouteCount:            status.routeCount,
		InferenceCatalogReady: status.ready,
		InferenceCatalogStale: status.stale,
	}
}
