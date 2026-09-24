package inferencegateway

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidPinnedAccount 表示请求级固定账号不是规范 AccountRef。
	ErrInvalidPinnedAccount = errors.New("固定推理账号无效")
)

// pinnedAccountContextKey 使用私有零尺寸类型隔离请求级路由元数据。
type pinnedAccountContextKey struct{}

// WithPinnedAccount 返回只携带固定 AccountRef 的子 Context。
//
// 本函数不读取账号或凭据；账号资格仍由征召器按模型、运行态和认证合同校验。
func WithPinnedAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (context.Context, error) {
	if ctx == nil || !accountRef.IsValid() {
		return nil, ErrInvalidPinnedAccount
	}
	return context.WithValue(ctx, pinnedAccountContextKey{}, accountRef), nil
}

// accountObserverContextKey 隔离请求级「本次尝试使用了哪个账号」观察者。
type accountObserverContextKey struct{}

// AccountObserver 在每次单账号尝试开始前收到账号与 Provider；最后一次调用即服务该请求的账号。
// HTTP 入站用它在响应头提交前写入 x-aih-server-account-ref（与 Node 宿主一致）。
type AccountObserver func(accountRef accountcore.AccountRef, providerID string)

// WithAccountObserver 返回携带账号观察者的子 Context；nil 观察者原样返回。
func WithAccountObserver(ctx context.Context, observer AccountObserver) context.Context {
	if ctx == nil || observer == nil {
		return ctx
	}
	return context.WithValue(ctx, accountObserverContextKey{}, observer)
}

// observeAccount 通知当前请求的账号观察者（若有）。
func observeAccount(ctx context.Context, accountRef accountcore.AccountRef, providerID string) {
	if ctx == nil {
		return
	}
	if observer, ok := ctx.Value(accountObserverContextKey{}).(AccountObserver); ok && observer != nil {
		observer(accountRef, providerID)
	}
}

// PinnedAccount 返回请求明确固定的账号；未设置时返回 false。
func PinnedAccount(ctx context.Context) (accountcore.AccountRef, bool) {
	if ctx == nil {
		return "", false
	}
	accountRef, ok := ctx.Value(pinnedAccountContextKey{}).(accountcore.AccountRef)
	return accountRef, ok && accountRef.IsValid()
}
