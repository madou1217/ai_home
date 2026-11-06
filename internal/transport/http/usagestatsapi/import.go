package usagestatsapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

// ImportPath 接收 Node 历史用量的批量导入（一次性迁移 + 可重试）。
const ImportPath = "/v1/management/usage/import"

// MaxImportEvents 限制单批事件数：百万行分多批导入，避免单请求体过大与长事务。
const MaxImportEvents = 2000

// ImportSource 是导入端口；幂等由实现方按 source_key 保证。
type ImportSource interface {
	ImportUsageEvents(context.Context, []usageledger.ImportEvent) (int, int, error)
}

type ImportHandler struct {
	authorizer Authorizer
	source     ImportSource
}

func NewImportHandler(authorizer Authorizer, source ImportSource) (*ImportHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidRecord
	}
	return &ImportHandler{authorizer: authorizer, source: source}, nil
}

type importEventDTO struct {
	SourceKey             string `json:"source_key"`
	AccountRef            string `json:"account_ref"`
	Provider              string `json:"provider"`
	Model                 string `json:"model"`
	SessionID             string `json:"session_id"`
	OccurredAtMS          int64  `json:"occurred_at_ms"`
	InputTokens           int    `json:"input_tokens"`
	OutputTokens          int    `json:"output_tokens"`
	CachedInputTokens     int    `json:"cached_input_tokens"`
	CacheWriteInputTokens int    `json:"cache_write_input_tokens"`
	ReasoningTokens       int    `json:"reasoning_tokens"`
	TotalTokens           int    `json:"total_tokens"`
}

type importRequest struct {
	Events []importEventDTO `json:"events"`
}

func (handler *ImportHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "unauthorized", "message": "需要管理密钥"},
		})
		return
	}
	if request.Method != http.MethodPost {
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"error": map[string]string{"code": "method_not_allowed", "message": "只接受 POST"},
		})
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 8<<20))
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"error": map[string]string{"code": "invalid_request_body", "message": "请求体读取失败"},
		})
		return
	}
	var payload importRequest
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Events) == 0 {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"error": map[string]string{"code": "invalid_request_body", "message": "events 不能为空"},
		})
		return
	}
	if len(payload.Events) > MaxImportEvents {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"error": map[string]string{"code": "too_many_events", "message": "单批事件过多"},
		})
		return
	}
	events := make([]usageledger.ImportEvent, 0, len(payload.Events))
	for _, dto := range payload.Events {
		events = append(events, toImportEvent(dto))
	}
	imported, skipped, err := handler.source.ImportUsageEvents(request.Context(), events)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "import_failed", "message": "导入失败"},
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"data": map[string]int{"imported": imported, "skipped": skipped},
	})
}

// toImportEvent 只做类型转换；合法性交给 ImportEvent.IsValid（存储层把坏行计入 skipped）。
func toImportEvent(dto importEventDTO) usageledger.ImportEvent {
	ref, _ := accountcore.ParseAccountRef(dto.AccountRef)
	return usageledger.ImportEvent{
		SourceKey:             dto.SourceKey,
		AccountRef:            ref,
		Provider:              dto.Provider,
		Model:                 dto.Model,
		SessionID:             dto.SessionID,
		OccurredAt:            time.UnixMilli(dto.OccurredAtMS).UTC(),
		InputTokens:           dto.InputTokens,
		OutputTokens:          dto.OutputTokens,
		CachedInputTokens:     dto.CachedInputTokens,
		CacheWriteInputTokens: dto.CacheWriteInputTokens,
		ReasoningTokens:       dto.ReasoningTokens,
		TotalTokens:           dto.TotalTokens,
	}
}
