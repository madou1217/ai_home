package webuiegressupstreamsapi

import (
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"net/http"
	"strings"
)

func (handler *Handler) serveRoutingTest(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodPost) {
		return
	}
	manager, ok := handler.manager.(RoutingPolicyManager)
	if !ok {
		writeJSON(responseWriter, http.StatusNotImplemented, map[string]any{"ok": false, "error": "routing_unavailable"})
		return
	}
	var body struct {
		Target string `json:"target"`
	}
	if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, false) {
		return
	}
	result, err := manager.GetRoutingPolicy(request.Context()).MatchTarget(body.Target)
	if err != nil {
		writeError(responseWriter, http.StatusBadRequest, err.Error(), "目标无效")
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "result": result})

}

func (handler *Handler) serveRouting(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	manager, ok := handler.manager.(RoutingPolicyManager)
	if !ok {
		writeJSON(responseWriter, http.StatusNotImplemented, map[string]any{"ok": false, "error": "routing_unavailable"})
		return
	}
	switch request.Method {
	case http.MethodGet:
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "policy": manager.GetRoutingPolicy(request.Context())})
		return
	case http.MethodPut, http.MethodPost:
		var body struct {
			Policy  runtimeegress.RoutingPolicy `json:"policy"`
			Restart bool                        `json:"restart"`
		}
		if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, false) {
			return
		}
		policy, err := manager.SaveRoutingPolicy(request.Context(), body.Policy, body.Restart)
		if err != nil {
			if strings.HasPrefix(err.Error(), "pool_restart_failed") {
				writeJSON(responseWriter, http.StatusOK, map[string]any{
					"ok": true, "policy": policy, "applied": false, "error": err.Error(),
				})
				return
			}
			writeError(responseWriter, http.StatusBadRequest, "routing_policy_invalid", err.Error())
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "policy": policy, "applied": true})
		return
	default:
		responseWriter.Header().Set("Allow", "GET, PUT, POST")
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/PUT/POST")
		return
	}

}
