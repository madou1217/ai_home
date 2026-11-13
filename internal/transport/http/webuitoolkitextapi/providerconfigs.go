package webuitoolkitextapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

const providerConfigMaxBodyBytes = 3 * 1024 * 1024

func (h *Handler) serveProviderConfigs(w http.ResponseWriter, r *http.Request, path string) {
	if h.providerConfigs == nil {
		writeError(w, http.StatusServiceUnavailable, "provider_configs_unavailable", "Provider 配置服务不可用")
		return
	}

	if path == ProviderConfigsPath {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
			return
		}
		includeCLI := r.URL.Query().Get("includeCliVersions") == "1" ||
			strings.EqualFold(r.URL.Query().Get("includeCliVersions"), "true")
		writeJSON(w, http.StatusOK, h.providerConfigs.ListProviders(r.Context(), includeCLI))
		return
	}

	rest := strings.TrimPrefix(path, ProviderConfigsPath+"/")
	rawParts := splitNonEmptyParts(rest)
	if len(rawParts) == 0 {
		writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")
		return
	}
	parts := make([]string, len(rawParts))
	for i, seg := range rawParts {
		decoded, ok := unescapeSegment(seg)
		if !ok {
			writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")
			return
		}
		parts[i] = decoded
	}

	switch len(parts) {
	case 2:
		provider, fileID := parts[0], parts[1]
		switch r.Method {
		case http.MethodGet:
			resp, err := h.providerConfigs.ReadFile(r.Context(), provider, fileID)
			h.writeProviderConfigResult(w, resp, err)
		case http.MethodPut:
			body, err := readProviderConfigBody(w, r)
			if err != nil {
				return
			}
			content, ok := body["content"].(string)
			if !ok {
				writeError(w, http.StatusBadRequest, "content_required", "必须提供配置文本内容")
				return
			}
			revision, _ := body["revision"].(string)
			note, _ := body["note"].(string)
			resp, err := h.providerConfigs.SaveFile(r.Context(), provider, fileID, content, providerconfigs.SaveOptions{
				ExpectedRevision: revision,
				Note:             note,
			})
			h.writeProviderConfigResult(w, resp, err)
		default:
			w.Header().Set("Allow", "GET, PUT")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET / PUT")
		}

	case 3:
		provider, fileID, action := parts[0], parts[1], parts[2]
		switch {
		case action == "history" && r.Method == http.MethodGet:
			resp, err := h.providerConfigs.ListHistory(provider, fileID)
			h.writeProviderConfigResult(w, resp, err)
		case action == "validate" && r.Method == http.MethodPost:
			body, err := readProviderConfigBody(w, r)
			if err != nil {
				return
			}
			content, ok := body["content"].(string)
			if !ok {
				writeError(w, http.StatusBadRequest, "content_required", "必须提供配置文本内容")
				return
			}
			resp, err := h.providerConfigs.ValidateFile(provider, fileID, content)
			h.writeProviderConfigResult(w, resp, err)
		case action == "export" && r.Method == http.MethodGet:
			mode := strings.TrimSpace(r.URL.Query().Get("mode"))
			if mode == "" {
				mode = "redacted"
			}
			resp, err := h.providerConfigs.ExportFile(r.Context(), provider, fileID, mode)
			h.writeProviderConfigResult(w, resp, err)
		default:
			writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")
		}

	case 4:
		provider, fileID, action, entryID := parts[0], parts[1], parts[2], parts[3]
		if action == "history" && r.Method == http.MethodGet {
			resp, err := h.providerConfigs.ReadHistoryEntry(provider, fileID, entryID)
			h.writeProviderConfigResult(w, resp, err)
			return
		}
		writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")

	case 5:
		provider, fileID, action, entryID, action2 := parts[0], parts[1], parts[2], parts[3], parts[4]
		if action == "history" && action2 == "restore" && r.Method == http.MethodPost {
			resp, err := h.providerConfigs.RestoreHistoryEntry(r.Context(), provider, fileID, entryID)
			h.writeProviderConfigResult(w, resp, err)
			return
		}
		writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")

	default:
		writeError(w, http.StatusNotFound, "provider_config_route_not_found", "未知的配置操作")
	}
}

func readProviderConfigBody(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	body, err := readJSONMap(w, r, providerConfigMaxBodyBytes)
	if err == nil {
		return body, nil
	}
	if errors.Is(err, errBodyTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "provider_config_too_large", "Body too large")
		return nil, err
	}
	writeError(w, http.StatusBadRequest, "invalid_json_body", "无效的 JSON 请求体")
	return nil, err
}

func (h *Handler) writeProviderConfigResult(w http.ResponseWriter, resp any, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, resp)
		return
	}
	if cfgErr, ok := providerconfigs.IsConfigError(err); ok {
		payload := map[string]any{
			"ok":      false,
			"error":   cfgErr.Code,
			"message": cfgErr.Message,
		}
		if cfgErr.Validation != nil {
			payload["validation"] = cfgErr.Validation
		}
		writeJSON(w, cfgErr.HTTPStatus(), payload)
		return
	}
	writeError(w, http.StatusInternalServerError, "provider_config_request_failed", err.Error())
}

func splitNonEmptyParts(path string) []string {
	raw := strings.Split(path, "/")
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}
