// Package modelaliasapi 是 Go 读取 Node 模型别名投影的管理接口。
//
// Node 控制面是别名表的唯一 owner：它在启动、别名变更后把启用的别名整体推给 Go，
// Go 只读这份投影并在下一次目录构建时编译为路由规则。本包只做 HTTP 边界，
// 不解释别名语义（编译在 inferencecatalog）。
package modelaliasapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/modelalias"
)

// Path 是 Node 推送模型别名投影的管理路径。
//
//	PUT /v1/management/model-aliases  整体替换，返回已接受的别名与丢弃原因
//	GET /v1/management/model-aliases  只读诊断
const Path = "/v1/management/model-aliases"

const maxProjectionBytes = 1 << 20

// refreshTimeout 限制一次推送触发的目录重建时长。
const refreshTimeout = 10 * time.Second

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
	// Refresh 触发一次路由目录重建，让新投影立即生效；可为 nil（只存不重建）。
	Refresh func(context.Context) error
	// Compilation 读取最近一次发布快照的别名编译结果；可为 nil。
	Compilation func() inferencecatalog.AliasCompilation
}

// Handler 接收 Node 的别名投影推送。
type Handler struct {
	authorizer  Authorizer
	store       *modelalias.Store
	refresh     func(context.Context) error
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
		refresh:     dependencies.Refresh,
		compilation: dependencies.Compilation,
	}, nil
}

type aliasPush struct {
	Aliases []modelalias.Record `json:"aliases"`
}

// aliasView 是返回给 Node 的投影状态：已接受 / 已应用代次与丢弃原因。
type aliasView struct {
	Generation        int64                        `json:"generation"`
	AppliedGeneration int64                        `json:"applied_generation"`
	AcceptedIDs       []string                     `json:"accepted_ids"`
	Dropped           []inferencecatalog.AliasDrop `json:"dropped"`
}

// ServeHTTP 只接受 Management Key 鉴权过的 GET 与 PUT。
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
		handler.put(response, request)
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 与 PUT")
	}
}

// put 校验并整体替换投影，然后触发一次目录重建。
func (handler *Handler) put(response http.ResponseWriter, request *http.Request) {
	var push aliasPush
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxProjectionBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&push); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_projection", "别名投影格式无效")
		return
	}
	if _, err := handler.store.Replace(push.Aliases); err != nil {
		// 整体拒绝：保留原投影，避免部分应用让别名解析出现空洞。
		writeError(response, http.StatusBadRequest, "invalid_projection", err.Error())
		return
	}
	// 立即重建，让 Node 在同一个响应里就能看到 applied_generation 追平。
	if handler.refresh != nil {
		ctx, cancel := context.WithTimeout(request.Context(), refreshTimeout)
		_ = handler.refresh(ctx)
		cancel()
	}
	writeView(response, http.StatusOK, handler.view())
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
