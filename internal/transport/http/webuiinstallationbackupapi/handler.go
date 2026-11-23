// Package webuiinstallationbackupapi 提供运行文件备份与恢复的管理契约。
//
//	GET    /v1/management/webui/installation-backups
//	POST   /v1/management/webui/installation-backups            {confirm,label}
//	POST   /v1/management/webui/installation-backups/{id}/restore {confirm}
//	DELETE /v1/management/webui/installation-backups/{id}?confirm=1
//
// 恢复只写回程序与 Web UI 文件；重启由调用方复用现有 /server/restart 契约。
package webuiinstallationbackupapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/installationbackup"
)

// Path 是备份管理的管理契约路径。
const Path = "/v1/management/webui/installation-backups"

// Authorizer 校验管理面请求。
type Authorizer interface{ Authorized(*http.Request) bool }

// Dependencies 汇总处理器依赖。
type Dependencies struct {
	Authorizer Authorizer
	Manager    *installationbackup.Manager
	MaxEntries int
}

// Handler 是备份契约的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	manager    *installationbackup.Manager
	maxEntries int
}

// NewHandler 创建处理器；缺依赖时失败关闭。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, errors.New("installation_backup_dependencies_invalid")
	}
	maxEntries := dependencies.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 5
	}
	return &Handler{authorizer: dependencies.Authorizer, manager: dependencies.Manager, maxEntries: maxEntries}, nil
}

type confirmBody struct {
	Confirm bool   `json:"confirm"`
	Label   string `json:"label,omitempty"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	write := func(code int, body any) {
		response.WriteHeader(code)
		_ = json.NewEncoder(response).Encode(body)
	}
	fail := func(code int, label string) {
		write(code, map[string]any{"ok": false, "error": label})
	}
	if handler == nil || handler.authorizer == nil || handler.manager == nil {
		fail(http.StatusServiceUnavailable, "installation_backup_unavailable")
		return
	}
	if !handler.authorizer.Authorized(request) {
		fail(http.StatusUnauthorized, "unauthorized")
		return
	}
	suffix := strings.TrimPrefix(request.URL.Path, Path)
	suffix = strings.TrimSuffix(suffix, "/")
	switch {
	case request.Method == http.MethodGet && suffix == "":
		handler.list(write, fail)
	case request.Method == http.MethodPost && suffix == "":
		var body confirmBody
		if !decodeConfirm(request, &body) {
			fail(http.StatusBadRequest, "explicit_confirmation_required")
			return
		}
		entry, err := handler.manager.Create(body.Label)
		if err != nil {
			fail(http.StatusServiceUnavailable, "installation_backup_create_failed")
			return
		}
		handler.listWith(write, fail, map[string]any{"created": entry})
	case request.Method == http.MethodPost && strings.HasSuffix(suffix, "/restore"):
		id := strings.TrimSuffix(strings.TrimPrefix(suffix, "/"), "/restore")
		var body confirmBody
		if !decodeConfirm(request, &body) {
			fail(http.StatusBadRequest, "explicit_confirmation_required")
			return
		}
		entry, err := handler.manager.Restore(id)
		if err != nil {
			fail(http.StatusConflict, "installation_backup_restore_failed")
			return
		}
		handler.listWith(write, fail, map[string]any{"restored": entry})
	case request.Method == http.MethodDelete && suffix != "":
		if request.URL.Query().Get("confirm") != "1" {
			fail(http.StatusBadRequest, "explicit_confirmation_required")
			return
		}
		if err := handler.manager.Delete(strings.TrimPrefix(suffix, "/")); err != nil {
			fail(http.StatusConflict, "installation_backup_delete_failed")
			return
		}
		handler.list(write, fail)
	default:
		fail(http.StatusNotFound, "not_found")
	}
}

func decodeConfirm(request *http.Request, body *confirmBody) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 4097))
	decoder.DisallowUnknownFields()
	if decoder.Decode(body) != nil || !body.Confirm {
		return false
	}
	return decoder.Decode(&struct{}{}) == io.EOF
}

func (handler *Handler) list(write func(int, any), fail func(int, string)) {
	handler.listWith(write, fail, nil)
}

func (handler *Handler) listWith(write func(int, any), fail func(int, string), extra map[string]any) {
	entries, err := handler.manager.List()
	if err != nil {
		fail(http.StatusServiceUnavailable, "installation_backup_list_failed")
		return
	}
	body := map[string]any{
		"ok":         true,
		"current":    handler.manager.Current(),
		"entries":    entries,
		"maxEntries": handler.maxEntries,
		"root":       handler.manager.RootDir(),
	}
	for key, value := range extra {
		body[key] = value
	}
	write(http.StatusOK, body)
}
