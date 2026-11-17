package pluginapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

// BrowserInventoryPath is the existing WebUI inventory entry. It shares the
// canonical reader and live projection; it does not proxy through Node.
const BrowserInventoryPath = "/v0/plugins"

type managementKeyConfiguration interface {
	ManagementKeyConfigured() bool
}

func (handler *InventoryHandler) serveBrowserInventory(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeBrowserInventoryError(response, http.StatusServiceUnavailable, "management_key_not_configured")
		return
	}
	configured, ok := handler.authorizer.(managementKeyConfiguration)
	if !ok || !configured.ManagementKeyConfigured() {
		writeBrowserInventoryError(response, http.StatusServiceUnavailable, "management_key_not_configured")
		return
	}
	if !handler.authorizer.Authorized(request) {
		writeBrowserInventoryError(response, http.StatusUnauthorized, "unauthorized_management")
		return
	}
	if request.Method != http.MethodGet {
		if request.Method == http.MethodPost {
			// The old public router parsed POST before rejecting its unknown
			// action, so retain its bounded malformed-body errors as well.
			const maxBodyBytes = 256 * 1024
			body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
			if len(body) > maxBodyBytes {
				writeBrowserInventoryJSON(response, http.StatusBadRequest, map[string]any{
					"ok": false, "error": "plugin_request_too_large", "message": "请求体过大", "diagnostics": []any{},
				})
				return
			}
			if err != nil || len(body) > 0 && !json.Valid(body) {
				writeBrowserInventoryJSON(response, http.StatusBadRequest, map[string]any{
					"ok": false, "error": "plugin_request_invalid", "message": "请求体不是合法 JSON", "diagnostics": []any{},
				})
				return
			}
			writeBrowserInventoryError(response, http.StatusNotFound, "not_found")
		} else {
			writeBrowserInventoryError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		}
		return
	}
	state, err := handler.reader.ReadControlState(request.Context())
	if err != nil {
		code := "plugin_state_unavailable"
		if errors.Is(err, pluginruntime.ErrControlStateInvalid) {
			code = "plugin_state_invalid"
		}
		writeInventoryError(response, http.StatusServiceUnavailable, code, "Go Core 未就绪，插件清单不可读")
		return
	}
	writeBrowserInventoryJSON(response, http.StatusOK, browserInventoryView(pluginruntime.BuildInventory(state, handler.projections)))
}

type browserRuntimeInventory struct {
	ActiveGeneration    int64                           `json:"activeGeneration"`
	Generations         []int64                         `json:"generations"`
	RetiringGenerations []int64                         `json:"retiringGenerations"`
	Contributions       []string                        `json:"contributions"`
	Instances           []pluginruntime.RuntimeInstance `json:"instances"`
}

type browserInventoryResponse struct {
	OK          bool                          `json:"ok"`
	ReadOnly    bool                          `json:"readOnly"`
	Source      string                        `json:"source"`
	Revision    int64                         `json:"revision"`
	Installed   []pluginruntime.InstalledView `json:"installed"`
	Instances   []pluginruntime.InstanceView  `json:"instances"`
	Runtime     browserRuntimeInventory       `json:"runtime"`
	Consistency pluginruntime.Consistency     `json:"consistency"`
}

// browserInventoryView preserves the public Node DTO: arrays never become
// null, nullable permissions stay null, and runtime contributions are IDs.
func browserInventoryView(inventory pluginruntime.Inventory) browserInventoryResponse {
	installed := append([]pluginruntime.InstalledView{}, inventory.Installed...)
	for index := range installed {
		item := &installed[index]
		item.Signature = browserObjectOr(item.Signature, json.RawMessage(`{"status":"unsigned"}`))
		item.Permissions = browserObjectOr(item.Permissions, json.RawMessage(`null`))
		item.Contributes = browserTextList(item.Contributes)
	}
	instances := append([]pluginruntime.InstanceView{}, inventory.Instances...)
	for index := range instances {
		instances[index].ConfigurationKeys = browserTextList(instances[index].ConfigurationKeys)
	}
	runtimeInstances := append([]pluginruntime.RuntimeInstance{}, inventory.Runtime.Instances...)
	for index := range runtimeInstances {
		runtimeInstances[index].Generations = append([]int64{}, runtimeInstances[index].Generations...)
	}
	contributions := make([]string, 0, len(inventory.Runtime.Contributions))
	for _, item := range inventory.Runtime.Contributions {
		if item.ID != "" {
			contributions = append(contributions, item.ID)
		}
	}
	consistency := inventory.Consistency
	consistency.Issues = append([]pluginruntime.Issue{}, consistency.Issues...)
	return browserInventoryResponse{
		OK: true, ReadOnly: true, Source: InventorySource, Revision: inventory.Revision,
		Installed: installed, Instances: instances,
		Runtime: browserRuntimeInventory{
			ActiveGeneration:    inventory.Runtime.ActiveGeneration,
			Generations:         append([]int64{}, inventory.Runtime.Generations...),
			RetiringGenerations: append([]int64{}, inventory.Runtime.RetiringGenerations...),
			Contributions:       contributions, Instances: runtimeInstances,
		},
		Consistency: consistency,
	}
}

func browserTextList(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func browserObjectOr(value json.RawMessage, fallback json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(value)
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		return value
	}
	return fallback
}

func writeBrowserInventoryError(response http.ResponseWriter, status int, code string) {
	writeBrowserInventoryJSON(response, status, map[string]any{"ok": false, "error": code})
}

func writeBrowserInventoryJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
