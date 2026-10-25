// Package managementstatusapi exposes authoritative Go host status facts to
// management clients. It intentionally omits metrics that have no Go owner.
package managementstatusapi

import (
	"encoding/json"
	"net/http"
)

const Path = "/v1/management/status"

type Authorizer interface{ Authorized(*http.Request) bool }

type Snapshot struct {
	Backend               string         `json:"backend"`
	ProviderMode          string         `json:"provider_mode"`
	Strategy              string         `json:"strategy"`
	Accounts              map[string]int `json:"-"`
	ModelCount            int            `json:"-"`
	RouteCount            int            `json:"-"`
	InferenceCatalogReady bool           `json:"-"`
	InferenceCatalogStale bool           `json:"-"`
}

type Source interface{ Snapshot() Snapshot }
type Handler struct {
	authorizer Authorizer
	source     Source
}

func NewHandler(authorizer Authorizer, source Source) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, http.ErrNotSupported
	}
	return &Handler{authorizer: authorizer, source: source}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "需要管理密钥"}})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"code": "method_not_allowed", "message": "只支持 GET"}})
		return
	}
	snapshot := handler.source.Snapshot()
	total, active := 0, 0
	for _, count := range snapshot.Accounts {
		total += count
		if count > 0 {
			active += count
		}
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                      true,
		"backend":                 snapshot.Backend,
		"provider_mode":           snapshot.ProviderMode,
		"strategy":                snapshot.Strategy,
		"total_accounts":          total,
		"active_accounts":         active,
		"cooldown_accounts":       total - active,
		"providers":               snapshot.Accounts,
		"models_cached":           snapshot.ModelCount,
		"route_count":             snapshot.RouteCount,
		"inference_catalog_ready": snapshot.InferenceCatalogReady,
		"inference_catalog_stale": snapshot.InferenceCatalogStale,
	})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
