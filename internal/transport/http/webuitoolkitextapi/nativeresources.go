package webuitoolkitextapi

import (
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

const nativeResourcesMaxBodyBytes = 128 * 1024

func (h *Handler) serveNativeResources(w http.ResponseWriter, r *http.Request) {
	if h.nativeResources == nil {
		writeError(w, http.StatusServiceUnavailable, "native_resources_unavailable", "原生资源服务不可用")
		return
	}

	switch r.Method {
	case http.MethodGet:
		report, err := h.nativeResources.Report(r.Context())
		if err != nil {
			writeNativeResourceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, report)

	case http.MethodPost:
		var input nativeresources.OperateInput
		if err := readJSONTarget(w, r, &input, nativeResourcesMaxBodyBytes); err != nil {
			if errors.Is(err, errBodyTooLarge) {
				writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
					"ok":    false,
					"error": "native_resource_payload_too_large",
				})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "native_resource_payload_invalid",
			})
			return
		}
		resp, err := h.nativeResources.Operate(r.Context(), input)
		if err != nil {
			writeNativeResourceError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)

	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET / POST")
	}
}

func writeNativeResourceError(w http.ResponseWriter, err error) {
	if de, ok := nativeresources.AsDomainError(err); ok {
		payload := map[string]any{
			"ok":    false,
			"error": de.Code,
		}
		if de.Detail != nil {
			payload["detail"] = de.Detail
		}
		writeJSON(w, de.HTTPStatus(), payload)
		return
	}
	code := err.Error()
	if code == "" {
		code = "native_resource_operation_failed"
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"ok":    false,
		"error": code,
	})
}
