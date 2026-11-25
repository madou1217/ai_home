// Package webuiswapapi 暴露当前 Server 主机的交换空间管理。
//
// 只对 Management Key 开放；非 Linux（macOS/Windows）返回 supported=false，
// 前端据此完全不渲染入口。
package webuiswapapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/swapctl"
)

const Path = "/v1/management/system/swap"

type Authorizer interface {
	Authorized(*http.Request) bool
}

type Dependencies struct {
	Authorizer Authorizer
	Manager    *swapctl.Manager
}

type Handler struct {
	authorizer Authorizer
	manager    *swapctl.Manager
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, errors.New("swap handler dependencies are invalid")
	}
	return &Handler{authorizer: dependencies.Authorizer, manager: dependencies.Manager}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	switch request.Method {
	case http.MethodGet:
		status := handler.manager.Status()
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "swap": status})
	case http.MethodPost:
		var body struct {
			SizeMB int `json:"sizeMb"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_json"})
			return
		}
		if body.SizeMB <= 0 {
			writeJSON(response, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": "sizeMb 必须为正整数"})
			return
		}
		status, err := handler.manager.Apply(body.SizeMB)
		if err != nil {
			writeJSON(response, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": err.Error(), "swap": status})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "swap": status})
	case http.MethodDelete:
		status, err := handler.manager.Remove()
		if err != nil {
			writeJSON(response, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": err.Error(), "swap": status})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "swap": status})
	default:
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}