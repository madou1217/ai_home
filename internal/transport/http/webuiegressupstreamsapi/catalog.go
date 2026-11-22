package webuiegressupstreamsapi

import (
	"net/http"
)

func (handler *Handler) serveStrategies(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodGet) {
		return
	}
	manager, ok := handler.manager.(StrategyCatalogManager)
	if !ok {
		writeJSON(responseWriter, http.StatusNotImplemented, map[string]any{"ok": false, "error": "strategies_unavailable"})
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"ok":         true,
		"strategies": manager.StrategyCatalog(request.Context()),
	})

}

func (handler *Handler) serveDiagnostics(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodGet) {
		return
	}
	manager, ok := handler.manager.(DiagnosticsManager)
	if !ok {
		writeJSON(responseWriter, http.StatusNotImplemented, map[string]any{"ok": false, "error": "diagnostics_unavailable"})
		return
	}
	writeJSON(responseWriter, http.StatusOK, manager.Diagnostics(request.Context()))

}
