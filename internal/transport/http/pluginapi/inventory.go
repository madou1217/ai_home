package pluginapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

// InventoryPath 是只读插件清单的管理路径。
//
//	GET /v1/management/plugins
//
// 与 /v1/management/plugins/projection 并列：projection 收 Node 推送的存活代次，
// 本接口把「控制面期望状态」与「Go 已确认的投影」拼在一起返回。
//
// 插件安装与启停仍归 Node：状态在 app-state.db 的 app_kv 里，启用还要经过宿主
// prepare 与 revision CAS。因此这里只有 GET；写请求返回 405 并显式标记只读边界。
const InventoryPath = "/v1/management/plugins"

// InventorySource 标明清单里的控制面事实来自 Node 的 app-state.db。
const InventorySource = "node-app-state"

// ControlStateReader 是读取 Node 插件控制状态的端口。
type ControlStateReader interface {
	ReadControlState(ctx context.Context) (pluginruntime.ControlState, error)
}

// InventoryHandler 提供只读插件清单。
type InventoryHandler struct {
	authorizer  Authorizer
	reader      ControlStateReader
	projections pluginruntime.LiveProjections
}

// NewInventoryHandler 创建只读清单接口；任一依赖缺失都拒绝装配，避免挂出永远 500 的路由。
func NewInventoryHandler(
	authorizer Authorizer,
	reader ControlStateReader,
	projections pluginruntime.LiveProjections,
) (*InventoryHandler, error) {
	if authorizer == nil || reader == nil || projections == nil {
		return nil, ErrInvalidDependencies
	}
	return &InventoryHandler{authorizer: authorizer, reader: reader, projections: projections}, nil
}

func (handler *InventoryHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || !handler.authorizer.Authorized(request) {
		writeInventoryError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		// 只读边界是刻意的：写入口必须留在 Node，否则控制面 revision 与
		// 宿主实际代次会分叉。调用方看 Allow: GET 就知道该走哪条链路。
		response.Header().Set("Allow", http.MethodGet)
		writeInventoryError(response, http.StatusMethodNotAllowed, "plugin_control_read_only",
			"插件启停仍由 Node 控制面持有，Go 只提供只读清单")
		return
	}
	state, err := handler.reader.ReadControlState(request.Context())
	if err != nil {
		code := "plugin_state_unavailable"
		message := "插件控制状态不可读"
		if errors.Is(err, pluginruntime.ErrControlStateInvalid) {
			code = "plugin_state_invalid"
			message = "插件控制状态格式无效"
		}
		writeInventoryError(response, http.StatusServiceUnavailable, code, message)
		return
	}
	inventory := pluginruntime.BuildInventory(state, handler.projections)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	// 管理面数据跟随控制面 revision 变化，不允许浏览器或中间层缓存。
	response.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(response).Encode(inventoryResponse{
		OK:        true,
		ReadOnly:  true,
		Source:    InventorySource,
		Inventory: inventory,
	})
}

// inventoryResponse 在 Node /v0/plugins 的列表字段外追加只读标记与来源。
//
// 字段整体向后兼容：WebUI 现在读 revision/installed/instances，切到 Go 时无需改解析。
type inventoryResponse struct {
	OK       bool   `json:"ok"`
	ReadOnly bool   `json:"readOnly"`
	Source   string `json:"source"`
	pluginruntime.Inventory
}

// writeInventoryError 使用 Node 插件管理面的错误形状（ok/error/message），
// 与 projection 接口的 OpenAI 错误壳区分：本接口的消费方是 WebUI 与 CLI。
func writeInventoryError(response http.ResponseWriter, status int, code string, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}
