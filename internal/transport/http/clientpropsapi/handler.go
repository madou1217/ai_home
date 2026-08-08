// Package clientpropsapi 提供客户端能力协商端点。
//
// 部分 OpenAI 兼容客户端在首次调用前会先探测该端点；缺失时它们会按「网关不完整」
// 处理并中断。Node 网关（lib/server/v1-router.js:1011）返回固定的空属性对象，
// Go 侧沿用同一形状，避免两套实现给出不同答案。
package clientpropsapi

import (
	"encoding/json"
	"errors"
	"net/http"
)

const (
	// Path 与 Node 网关暴露的路径保持一致。
	Path = "/v1/props"
	// objectName 是响应的稳定类型标识。
	objectName = "props"
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("客户端属性 Handler 依赖无效")

// propsResponse 是端点的完整响应形状。
//
// Data 恒为空对象而非省略：客户端按 `data` 存在与否判断响应是否完整，
// 省略会被当成协议不兼容。
type propsResponse struct {
	Object string         `json:"object"`
	Data   map[string]any `json:"data"`
}

// Handler 以只读方式回答客户端能力协商。
type Handler struct{}

// NewHandler 创建无外部依赖的属性 Handler。
func NewHandler() *Handler {
	return &Handler{}
}

// ServeHTTP 只接受 GET，其余方法按 405 拒绝。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil || response == nil || request == nil {
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"error": map[string]any{
				"type":    "invalid_request_error",
				"message": "Method not allowed",
			},
		})
		return
	}
	writeJSON(response, http.StatusOK, propsResponse{
		Object: objectName,
		Data:   map[string]any{},
	})
}

// writeJSON 写入禁止缓存与 MIME 猜测的 JSON 响应。
func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
