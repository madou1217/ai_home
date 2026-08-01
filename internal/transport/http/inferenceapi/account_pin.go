package inferenceapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// AccountRefHeader 是 Gateway 客户端固定服务端账号的唯一标准请求头。
	AccountRefHeader = "X-Account-Ref"
)

var (
	// ErrInvalidAccountRefHeader 表示固定账号请求头重复、为空或不是规范 AccountRef。
	ErrInvalidAccountRefHeader = errors.New("固定账号请求头无效")
)

// ContextWithPinnedAccount 校验可选请求头并返回带请求级路由约束的 Context。
func ContextWithPinnedAccount(request *http.Request) (context.Context, error) {
	if request == nil {
		return nil, ErrInvalidAccountRefHeader
	}
	values := request.Header.Values(AccountRefHeader)
	if len(values) == 0 {
		return request.Context(), nil
	}
	if len(values) != 1 {
		return nil, ErrInvalidAccountRefHeader
	}
	value := strings.TrimSpace(values[0])
	if value == "" || value != values[0] || strings.Contains(value, ",") {
		return nil, ErrInvalidAccountRefHeader
	}
	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		return nil, ErrInvalidAccountRefHeader
	}
	ctx, err := inferencegateway.WithPinnedAccount(request.Context(), accountRef)
	if err != nil {
		return nil, ErrInvalidAccountRefHeader
	}
	return ctx, nil
}
