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
	Intent   string `json:"intent"`
	Excluded bool   `json:"excluded"`
	Reason   string `json:"reason"`
}

// The response reports effective eligibility separately from manual intent.
type accountRoutingView struct {
	AccountRef      string `json:"account_ref"`
	Excluded        bool   `json:"excluded"`
	ManualExcluded  bool   `json:"manual_excluded"`
	DerivedExcluded bool   `json:"derived_excluded"`
	DerivedReason   string `json:"derived_reason,omitempty"`
}

type routingExclusionReader interface {
	RoutingExclusionState(context.Context, accountcore.AccountRef) (bool, bool, string, error)
}

type accountRoutingResponse struct {
	Data accountRoutingView `json:"data"`
}

// handleAccountRouting updates manual intent only; typed credential and Go
// capability exclusions cannot be overridden by the retired Node writer.
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
	if reason == "no_go_upstream" || reason == "custom_upstream_relay" {
		writeAPIError(response, http.StatusConflict, "routing_derived_owned_by_go", "派生路由排除由 Go 权威计算")
		return
	}
	// Retired loaded Node instances send included/blank without user intent.
	// Do not let that ambiguous old request overwrite a real manual preference.
	if payload.Intent != "manual" {
		writeAPIError(response, http.StatusConflict, "routing_manual_intent_required", "人工路由变更必须显式声明 intent:manual")
		return
	}
	reader, ok := handler.routingExclusions.(routingExclusionReader)
	if !ok {
		writeAPIError(response, http.StatusServiceUnavailable, "routing_exclusion_unavailable", "路由排除读取不可用")
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
	manual, derived, derivedReason, err := reader.RoutingExclusionState(request.Context(), accountRef)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, accountRoutingResponse{Data: accountRoutingView{
		AccountRef: accountRef.String(), Excluded: manual || derived, ManualExcluded: manual, DerivedExcluded: derived, DerivedReason: derivedReason,
	}})
}
