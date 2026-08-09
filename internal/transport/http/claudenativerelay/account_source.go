package claudenativerelay

import (
	"context"
	"errors"
	"net/http"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrNoRelayAccount 表示当前模型没有可用于透传的账号。
var ErrNoRelayAccount = errors.New("没有可用于 Claude Relay 的账号")

// AccountSource 按模型产出候选账号。
//
// 抽象成「游标」而不是「取一个」，是因为透传同样需要多账号故障转移：上游在
// 首字节之前失败且可重试时，网关应换号重发，而不是把失败直接抛给客户端。
// Canonical 路径本就具备这个能力，透传若缺失就是可用性退化。
type AccountSource interface {
	Accounts(
		ctx context.Context,
		modelID runtimecore.ModelID,
	) (AccountCursor, error)
}

// AccountCursor 按调度顺序逐个产出账号，耗尽时返回 false。
type AccountCursor interface {
	Next(ctx context.Context) (accountcore.AccountRef, bool, error)
}

// leaseAccountSource 把既有租约鉴权包装成单账号来源。
//
// 官方客户端携带 Relay Token 时账号已被租约唯一确定，不参与调度，也不轮转——
// 租约的语义就是「就用这一个」。
type leaseAccountSource struct {
	accountRef accountcore.AccountRef
	model      runtimecore.ModelID
}

// newLeaseAccountSource 创建绑定单个已授权账号的来源。
func newLeaseAccountSource(
	accountRef accountcore.AccountRef,
	model runtimecore.ModelID,
) *leaseAccountSource {
	return &leaseAccountSource{accountRef: accountRef, model: model}
}

// Accounts 校验模型与租约一致后返回单账号游标。
func (source *leaseAccountSource) Accounts(
	_ context.Context,
	modelID runtimecore.ModelID,
) (AccountCursor, error) {
	if source == nil || modelID != source.model {
		return nil, ErrNoRelayAccount
	}
	return &singleAccountCursor{accountRef: source.accountRef}, nil
}

// singleAccountCursor 只产出一个账号，之后即耗尽。
type singleAccountCursor struct {
	accountRef accountcore.AccountRef
	consumed   bool
}

// Next 首次返回租约账号，其后返回耗尽。
func (cursor *singleAccountCursor) Next(
	_ context.Context,
) (accountcore.AccountRef, bool, error) {
	if cursor == nil || cursor.consumed {
		return "", false, nil
	}
	cursor.consumed = true
	return cursor.accountRef, true, nil
}

// resolveAccountSource 决定本次请求的账号来源。
//
// 携带有效租约时用租约账号；否则交给调度器。两者互斥：租约存在即表示调用方
// 已经指定账号，不应再被网关改派。
func (handler *Handler) resolveAccountSource(
	request *http.Request,
) (AccountSource, bool) {
	if accountRef, model, ok := handler.authorizer.Authorize(request); ok {
		return newLeaseAccountSource(accountRef, model), true
	}
	if handler.accounts == nil {
		return nil, false
	}
	return handler.accounts, true
}
