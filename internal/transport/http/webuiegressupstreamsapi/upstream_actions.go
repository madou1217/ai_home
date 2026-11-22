package webuiegressupstreamsapi

import (
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"net/http"
	"strings"
)

func (handler *Handler) serveUpstreamProbe(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodPost) {
		return
	}
	rawID := strings.TrimSuffix(rest, "/probe")
	if strings.Contains(rawID, "/") {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到路由")
		return
	}
	id, ok := unescapeSegment(rawID)
	if !ok {
		writeError(responseWriter, http.StatusNotFound, "upstream_not_found", "未找到上游")
		return
	}
	var body struct {
		Nodes []string `json:"nodes"`
	}
	if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, true) {
		return
	}
	result, status := handler.manager.StartUpstreamProbe(request.Context(), id, body.Nodes)
	writeJSON(responseWriter, status, result)

}

func (handler *Handler) serveProbeAccount(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodPost) {
		return
	}
	rawID := strings.TrimSuffix(rest, "/probe-account")
	if strings.Contains(rawID, "/") {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到路由")
		return
	}
	id, ok := unescapeSegment(rawID)
	if !ok {
		writeError(responseWriter, http.StatusNotFound, "upstream_not_found", "未找到上游")
		return
	}
	var body struct {
		AccountRef string `json:"accountRef"`
	}
	if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, false) {
		return
	}
	probeManager, ok := handler.manager.(AccountUpstreamProbeManager)
	if !ok {
		writeJSON(responseWriter, http.StatusNotImplemented, runtimeegress.AccountUpstreamProbeResult{
			OK: false, Status: "skipped", Reason: "account_probe_unavailable",
		})
		return
	}
	result, status := probeManager.ProbeUpstreamAccount(request.Context(), id, body.AccountRef)
	writeJSON(responseWriter, status, result)

}

func (handler *Handler) serveEvidenceReset(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodPost) {
		return
	}
	rawID := strings.TrimSuffix(rest, "/evidence/reset")
	if strings.Contains(rawID, "/") {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到路由")
		return
	}
	id, ok := unescapeSegment(rawID)
	if !ok {
		writeError(responseWriter, http.StatusNotFound, "upstream_not_found", "未找到上游")
		return
	}
	var body struct {
		ExitKeys []string `json:"exitKeys"`
	}
	if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, true) {
		return
	}
	removed, status, code := handler.manager.ResetUpstreamEvidence(request.Context(), id, body.ExitKeys)
	if status != http.StatusOK {
		writeError(responseWriter, status, code, "未找到上游")
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "removed": removed})

}

func (handler *Handler) serveUpstreamDetail(responseWriter http.ResponseWriter, request *http.Request, rest string) {
	if !requireMethod(responseWriter, request, http.MethodPut) {
		return
	}
	id, ok := unescapeSegment(rest)
	if !ok || strings.TrimSpace(id) == "" {
		writeError(responseWriter, http.StatusBadRequest, "invalid_upstream_id", "上游 ID 无效")
		return
	}
	var patch runtimeegress.UpstreamPolicyPatch
	if !readJSONObject(responseWriter, request, &patch, maxUpstreamBodyBytes, true) {
		return
	}
	policy, err := handler.manager.UpdateUpstreamPolicy(request.Context(), id, patch)
	if err != nil {
		if err.Error() == "invalid_upstream_id" {
			writeError(responseWriter, http.StatusBadRequest, "invalid_upstream_id", "上游 ID 无效")
			return
		}
		writeError(responseWriter, http.StatusInternalServerError, err.Error(), "保存上游策略失败")
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "policy": policy})

}
