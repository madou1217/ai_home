// Package accountusageeventsapi 暴露成功上游尝试 token 用量事件的增量只读管理接口。
//
// Node 按 (boot_id, seq) 游标轮询，把 Go 承接流量计入账号 Token 用量并实时推送到账号页。
package accountusageeventsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/madou1217/ai_home/application/accountusagefeed"
)

// Path 是用量事件的只读管理路径。
//
//	GET /v1/management/account-usage-events?after_seq=<n>
const Path = "/v1/management/account-usage-events"

// ErrInvalidDependencies 表示 Handler 缺少事件源或管理鉴权。
var ErrInvalidDependencies = errors.New("账号用量事件 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Source 是用量事件环的只读端口。
type Source interface {
	UsageEventsSince(after uint64) ([]accountusagefeed.Event, uint64, bool)
	UsageBootID() string
}

// Handler 只接受带管理密钥的 GET。
type Handler struct {
	authorizer Authorizer
	source     Source
}

// NewHandler 创建只读 Handler。
func NewHandler(authorizer Authorizer, source Source) (*Handler, error) {
	if authorizer == nil || source == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: authorizer, source: source}, nil
}

type eventView struct {
	Seq                   uint64 `json:"seq"`
	AccountRef            string `json:"account_ref"`
	Model                 string `json:"model"`
	AtMS                  int64  `json:"at_ms"`
	InputTokens           uint64 `json:"input_tokens"`
	OutputTokens          uint64 `json:"output_tokens"`
	CachedInputTokens     uint64 `json:"cached_input_tokens"`
	CacheWriteInputTokens uint64 `json:"cache_write_input_tokens"`
	ReasoningTokens       uint64 `json:"reasoning_tokens"`
	TotalTokens           uint64 `json:"total_tokens"`
}

type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ServeHTTP 返回 after_seq 之后的事件、当前最新序号与进程实例标识。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]errorView{"error": {Code: "unauthorized", Message: "管理密钥无效"}})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]errorView{"error": {Code: "method_not_allowed", Message: "只支持 GET"}})
		return
	}
	after := uint64(0)
	if raw := request.URL.Query().Get("after_seq"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]errorView{"error": {Code: "invalid_query", Message: "after_seq 必须是非负整数"}})
			return
		}
		after = parsed
	}
	events, latest, truncated := handler.source.UsageEventsSince(after)
	views := make([]eventView, 0, len(events))
	for _, event := range events {
		views = append(views, eventView{
			Seq:                   event.Seq,
			AccountRef:            event.AccountRef.String(),
			Model:                 event.Model,
			AtMS:                  event.At.UnixMilli(),
			InputTokens:           event.Usage.InputTokens(),
			OutputTokens:          event.Usage.OutputTokens(),
			CachedInputTokens:     event.Usage.CachedInputTokens(),
			CacheWriteInputTokens: event.Usage.CacheWriteInputTokens(),
			ReasoningTokens:       event.Usage.ReasoningTokens(),
			TotalTokens:           event.Usage.TotalTokens(),
		})
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"boot_id":    handler.source.UsageBootID(),
		"latest_seq": latest,
		"truncated":  truncated,
		"data":       views,
	})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
