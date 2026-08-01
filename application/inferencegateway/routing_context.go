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

// PinnedAccount 返回请求明确固定的账号；未设置时返回 false。
func PinnedAccount(ctx context.Context) (accountcore.AccountRef, bool) {
	if ctx == nil {
		return "", false
	}
	accountRef, ok := ctx.Value(pinnedAccountContextKey{}).(accountcore.AccountRef)
	return accountRef, ok && accountRef.IsValid()
}
