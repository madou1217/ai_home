// Package pluginapi 是 Go 数据面接入插件发布投影的 HTTP 边界：
// Node 推送投影的管理接口，以及推理入口前的 gateway.request 闸门。
package pluginapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

// ProjectionPath 是 Node 推送全部存活代次投影的管理路径。
//
//	PUT /v1/management/plugins/projection  整体替换，返回已接受的代次
//	GET /v1/management/plugins/projection  只读诊断（不回显令牌）
const ProjectionPath = "/v1/management/plugins/projection"

const maxProjectionBytes = 1 << 20

// ErrInvalidDependencies 表示 Handler 缺少注册表或鉴权。
var ErrInvalidDependencies = errors.New("插件投影 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ProjectionHandler 接收 Node 的投影推送。
type ProjectionHandler struct {
	authorizer Authorizer
	registry   *appplugins.Registry
}

// NewProjectionHandler 创建投影管理接口。
func NewProjectionHandler(authorizer Authorizer, registry *appplugins.Registry) (*ProjectionHandler, error) {
	if authorizer == nil || registry == nil {
		return nil, ErrInvalidDependencies
	}
	return &ProjectionHandler{authorizer: authorizer, registry: registry}, nil
}

type projectionPush struct {
	Host struct {
		Address string `json:"address"`
		Token   string `json:"token"`
	} `json:"host"`
	Generations []appplugins.Projection `json:"generations"`
}

func (handler *ProjectionHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch request.Method {
	case http.MethodGet:
		writeGenerations(response, handler.liveGenerations())
	case http.MethodPut:
		var push projectionPush
		decoder := json.NewDecoder(io.LimitReader(request.Body, maxProjectionBytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&push); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_projection", "投影格式无效")
			return
		}
		accepted, err := handler.registry.Replace(appplugins.HostAccess{Address: push.Host.Address, Token: push.Host.Token}, push.Generations)
		if err != nil {
			writeError(response, http.StatusBadRequest, "invalid_projection", err.Error())
			return
		}
		writeGenerations(response, accepted)
	default:
		response.Header().Set("Allow", "GET, PUT")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 与 PUT")
	}
}

func (handler *ProjectionHandler) liveGenerations() []int64 {
	return handler.registry.Generations()
}

func writeGenerations(response http.ResponseWriter, generations []int64) {
	if generations == nil {
		generations = []int64{}
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(response).Encode(map[string]any{"data": map[string]any{"generations": generations}})
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	errorType := "invalid_request_error"
	if status >= 500 {
		errorType = "server_error"
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{"message": message, "type": errorType, "param": nil, "code": code}})
}
