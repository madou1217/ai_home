package inferencegateway

import (
	"context"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// AccountHintResolver 把会话级模型改写里的账号提示解析成规范账号与 Provider。
type AccountHintResolver interface {
	ResolveAccountHint(
		ctx context.Context,
		hint string,
		providerHint string,
	) (accountRef accountcore.AccountRef, provider string, err error)
}
