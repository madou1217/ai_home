package accountsapi

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// RoutingExclusionWriter 持久化账号级 Go 路由排除；为 nil 时该端点返回 503。
type RoutingExclusionWriter interface {
	SetRoutingExclusion(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		excluded bool,
		reason string,
		updatedAt time.Time,
	) error
}

// maxRoutingExclusionReasonRunes 限制原因长度：它是给人看的备注，不是数据字段，
// 允许无限长只会让一次误调用把整行撑大。按字符而非字节计数，中文原因才不会被腰斩。
const maxRoutingExclusionReasonRunes = 200

type accountRoutingRequest struct {
	Excluded bool   `json:"excluded"`
	Reason   string `json:"reason"`
}

type accountRoutingView struct {
	AccountRef string `json:"account_ref"`
	Excluded   bool   `json:"excluded"`
}

type accountRoutingResponse struct {
	Data accountRoutingView `json:"data"`
}

// handleAccountRouting 标记或解除账号的 Go 路由排除。
//
// 为什么由 Node 标记：判断一个账号是不是自定义上游，靠的是 Node 侧的凭据与
// baseUrl 语义；Go 只接收结论并按它过滤候选，不去猜上游归属。
func (handler *Handler) handleAccountRouting(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if handler.routingExclusions == nil {
		writeAPIError(response, http.StatusServiceUnavailable, "routing_exclusion_unavailable", "路由排除存储不可用")
		return
	}
	if request.Method != http.MethodPut {
		response.Header().Set("Allow", http.MethodPut)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var payload accountRoutingRequest
	if err := decodeJSONRequest(response, request, &payload); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	reason := strings.TrimSpace(payload.Reason)
	if utf8.RuneCountInString(reason) > maxRoutingExclusionReasonRunes {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_routing_exclusion",
			"排除原因不能超过 200 个字符",
		)
		return
	}
	if err := handler.routingExclusions.SetRoutingExclusion(
		request.Context(),
		accountRef,
		payload.Excluded,
		reason,
		time.Now().UTC(),
	); err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountRoutingResponse{
		Data: accountRoutingView{
			AccountRef: accountRef.String(),
			Excluded:   payload.Excluded,
		},
	})
}
