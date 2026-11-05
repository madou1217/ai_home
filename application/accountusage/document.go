package accountusage

import (
	"context"
	"encoding/json"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// ReplaceDocument 保存采集方写入的完整 Provider 快照文档。
//
// 文档与归一化额度快照是同一份采集结果的两个投影：这里只做领域校验，
// 账号存在性与 Provider 一致性由存储在同一事务中确认。
func (service *Service) ReplaceDocument(
	ctx context.Context,
	document usagecore.Document,
) error {
	if service == nil || ctx == nil || !document.IsValid() {
		return usagecore.ErrInvalidDocument
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := service.documents.ReplaceUsageDocument(ctx, document); err != nil {
		return err
	}
	return service.refreshDocumentQuotaState(ctx, document.AccountRef())
}

// refreshDocumentQuotaState 用当前文档与归一化事实重算物化额度状态。
//
// 状态是给 Node 服务端与 CLI 读的派生事实；计算只在这里做一次，消费方不再各自推导。
// 文档不存在时无事可做（账号还没有额度快照）。
func (service *Service) refreshDocumentQuotaState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	documents, err := service.documents.ListUsageDocuments(
		ctx,
		DocumentQuery{AccountRefs: []accountcore.AccountRef{accountRef}},
	)
	if err != nil {
		return err
	}
	if len(documents) == 0 {
		return nil
	}
	document := documents[0]
	remaining := usagecore.UnknownRemaining()
	snapshot, snapshotErr := service.store.GetUsageSnapshot(ctx, accountRef)
	switch {
	case snapshotErr == nil:
		remaining = snapshot.MinRemaining()
	case errors.Is(snapshotErr, ErrSnapshotNotFound):
	default:
		return snapshotErr
	}
	payload := parseDocumentPayloadFields(document.Payload())
	state := usagecore.DeriveQuotaState(usagecore.QuotaStateInput{
		Kind:           document.Kind(),
		FallbackSource: payload.FallbackSource,
		PlanType:       payload.Account.PlanType,
		Remaining:      remaining,
	})
	return service.documents.ReplaceUsageDocumentQuotaState(ctx, DocumentQuotaState{
		AccountRef: accountRef,
		Status:     state.Status,
		Reason:     state.Reason,
		Remaining:  remaining,
	})
}

// documentPayloadFields 只读额度状态需要的两个降级字段。
type documentPayloadFields struct {
	FallbackSource string `json:"fallbackSource"`
	Account        struct {
		PlanType string `json:"planType"`
	} `json:"account"`
}

func parseDocumentPayloadFields(payload []byte) documentPayloadFields {
	var fields documentPayloadFields
	_ = json.Unmarshal(payload, &fields)
	return fields
}

// ReplaceDocumentQuotaState 持久化物化的账号级额度状态。
//
// 读接口在派生后顺手回写，旧库升级后无需额外的回填任务；失败只会让 CLI 少一份缓存，
// 不影响读结果本身。
func (service *Service) ReplaceDocumentQuotaState(
	ctx context.Context,
	state DocumentQuotaState,
) error {
	if service == nil || ctx == nil || !state.AccountRef.IsValid() {
		return ErrInvalidRequest
	}
	return service.documents.ReplaceUsageDocumentQuotaState(ctx, state)
}

// ListDocuments 返回符合条件的完整文档；过滤为空表示全部账号。
func (service *Service) ListDocuments(
	ctx context.Context,
	query DocumentQuery,
) ([]usagecore.Document, error) {
	if service == nil || ctx == nil {
		return nil, ErrInvalidRequest
	}
	for _, accountRef := range query.AccountRefs {
		if !accountRef.IsValid() {
			return nil, ErrInvalidRequest
		}
	}
	return service.documents.ListUsageDocuments(ctx, query)
}
