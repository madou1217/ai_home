package webuisetdefaultapi

import (
	"context"
	"net/http"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
)

// HostDefaultTransaction owns both host publication and the authoritative
// default/pointer commit. Providers without it retain their existing adapters.
type HostDefaultTransaction interface {
	Supports(provider string) bool
	Select(ctx context.Context, provider string, ref accountcore.AccountRef, gateway bool) (accountcore.ProviderDefault, error)
}

func (handler *Handler) transactionDefault(response http.ResponseWriter, request *http.Request, scope accountScope, gateway bool) bool {
	if handler.transaction == nil || !handler.transaction.Supports(scope.provider) {
		return false
	}
	relation, err := handler.transaction.Select(request.Context(), scope.provider, scope.accountRef, gateway)
	if err != nil {
		handler.writeRelationError(response, err, "host_default_transaction_failed")
		return true
	}
	if gateway {
		writeJSON(response, http.StatusOK, clearDefaultView{OK: true, Provider: scope.provider, AccountRef: scope.accountRef.String(), AIServerDefault: landingView{OK: true, Landed: true, Profile: aihdefault.ServerProfileID}})
	} else {
		writeJSON(response, http.StatusOK, setDefaultView{OK: true, Provider: scope.provider, AccountRef: scope.accountRef.String(), Default: newDefaultRelationView(relation), LandingCleared: true})
	}
	return true
}
