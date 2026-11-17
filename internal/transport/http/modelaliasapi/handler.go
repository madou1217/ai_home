// Package modelaliasapi 提供 Go 模型别名的只读兼容诊断接口。
//
// Go CRUD 与 canonical Store 独占别名写入；旧 Node 整体投影 PUT 已退役，
// 鉴权后显式拒绝，避免旧客户端覆盖新配置或清空 tombstone。本包只做 HTTP 边界，
// 不解释别名语义（编译在 inferencecatalog）。
package modelaliasapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/modelalias"
)

// Path 是旧模型别名投影的兼容管理路径。
//
//	PUT /v1/management/model-aliases  鉴权后固定 409，不再写入
//	GET /v1/management/model-aliases  只读诊断
const Path = "/v1/management/model-aliases"

// ErrInvalidDependencies 表示 Handler 缺少投影存储或鉴权。
var ErrInvalidDependencies = errors.New("模型别名投影 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明别名投影管理接口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      *modelalias.Store
	// Refresh 仅保留装配兼容；退役写入口不调用它，GET 也不触发重建。
	Refresh func(context.Context) error
	// Compilation 读取最近一次发布快照的别名编译结果；可为 nil。
	Compilation func() inferencecatalog.AliasCompilation
}

// Handler 读取 Go 别名编译状态，拒绝旧客户端投影写入。
type Handler struct {
	authorizer  Authorizer
	store       *modelalias.Store
	compilation func() inferencecatalog.AliasCompilation
}

// NewHandler 创建别名投影管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		store:       dependencies.Store,
		compilation: dependencies.Compilation,
	}, nil
}

// aliasView 是返回给 Node 的投影状态：已接受 / 已应用代次与丢弃原因。
type aliasView struct {
	Generation        int64                        `json:"generation"`
	AppliedGeneration int64                        `json:"applied_generation"`
	AcceptedIDs       []string                     `json:"accepted_ids"`
	Dropped           []inferencecatalog.AliasDrop `json:"dropped"`
}

// ServeHTTP 先鉴权，再提供只读 GET 或显式拒绝已退役的 PUT。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "model_aliases_unavailable", "别名投影不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch request.Method {
	case http.MethodGet:
		writeView(response, http.StatusOK, handler.view())
	case http.MethodPut:
		writeError(response, http.StatusConflict, "model_alias_projection_retired", "旧别名投影写入已退役，请使用 Go 别名管理接口")
	default:
		response.Header().Set("Allow", "GET")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET；旧 PUT 已退役")
	}
}

// view 汇总存储代次与最近一次发布的编译结果。
func (handler *Handler) view() aliasView {
	view := aliasView{
		Generation:  handler.store.Generation(),
		AcceptedIDs: []string{},
		Dropped:     []inferencecatalog.AliasDrop{},
	}
	if handler.compilation == nil {
		return view
	}
	compilation := handler.compilation()
	view.AppliedGeneration = compilation.Generation
	if len(compilation.AcceptedIDs) > 0 {
		view.AcceptedIDs = compilation.AcceptedIDs
	}
	if len(compilation.Dropped) > 0 {
		view.Dropped = compilation.Dropped
	}
	return view
}

func writeView(response http.ResponseWriter, status int, view aliasView) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"data": view})
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	errorType := "invalid_request_error"
	if status >= 500 {
		errorType = "server_error"
	}
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"error": map[string]any{"message": message, "type": errorType, "param": nil, "code": code},
	})
}
