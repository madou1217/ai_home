package claudenativerelay

import (
	"context"
	"errors"
	"net/http"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
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

// resolveAccountSource 决定本次请求的账号来源，并报告是否来自租约。
//
// 携带有效租约时用租约账号；否则交给调度器。两者互斥：租约存在即表示调用方
// 已经指定账号，不应再被网关改派。
//
// 是否租约决定失败语义：租约调用方明确要求透传，不满足合同应当报错；无租约
// 调用方只是恰好打到这个路径，不满足合同应当交回 Canonical。
func (handler *Handler) resolveAccountSource(
	request *http.Request,
) (AccountSource, bool) {
	if accountRef, model, ok := handler.authorizer.Authorize(request); ok {
		return newLeaseAccountSource(accountRef, model), true
	}
	// 声明了 Relay Token 却没通过鉴权，必须按租约调用方拒绝，不能降级成普通
	// 客户端——否则无效 Token 会静默获得普通客户端权限，造成权限域混淆。
	if len(request.Header.Values(RelayTokenHeader)) > 0 {
		return nil, true
	}
	if handler.accounts == nil {
		return nil, false
	}
	// 客户端用 x-account-ref 钉选账号时，透传只能使用这个账号：调度器会按模型另挑
	// claude 账号，钉到 agy 等其它 Provider 的请求因此被静默改派（2026-09-25 agy relay 实测）。
	if values := request.Header.Values(inferenceapi.AccountRefHeader); len(values) > 0 {
		accountRef, err := accountcore.ParseAccountRef(strings.TrimSpace(values[0]))
		if err != nil || len(values) != 1 {
			// 非法钉选交回 Canonical，由其按协议返回 400。
			return pinnedAccountSource{}, false
		}
		return pinnedAccountSource{handler: handler, accountRef: accountRef}, false
	}
	return handler.accounts, false
}

// pinnedAccountSource 只在钉选账号本身是 claude 账号时透传；否则报告无可透传账号，
// 让调用方交回 Canonical（Canonical 同样按钉选只用该账号）。
type pinnedAccountSource struct {
	handler    *Handler
	accountRef accountcore.AccountRef
}

func (source pinnedAccountSource) Accounts(
	ctx context.Context,
	_ runtimecore.ModelID,
) (AccountCursor, error) {
	if source.handler == nil || source.handler.credentials == nil || !source.accountRef.IsValid() {
		return nil, ErrNoRelayAccount
	}
	binding, _, err := source.handler.credentials.ResolveObservedCredentialBinding(ctx, source.accountRef)
	if err != nil || !binding.IsValid() || binding.Credential().ProviderID() != "claude" {
		return nil, ErrNoRelayAccount
	}
	return &singleAccountCursor{accountRef: source.accountRef}, nil
}
