package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/images"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

// imageAccountEgress 把账号出口绑定投影到 Image Studio 的生图请求。
//
// 返回 nil,nil 表示账号未绑定出口，调用方继续使用注入的默认 HTTP 客户端。
type imageAccountEgress struct {
	clients *accountEgressClients
}

func newImageAccountEgress(manager func() *runtimeegress.Manager) *imageAccountEgress {
	// 生图请求由上游 context 限定总时长，客户端本身不设 Timeout。
	return &imageAccountEgress{clients: newAccountEgressClients(manager, 0)}
}

func (resolver *imageAccountEgress) HTTPForAccount(
	ctx context.Context,
	account images.Account,
) (images.HTTPDoer, error) {
	client, bound, err := resolver.clients.clientForAccount(ctx, account.Provider, account.AccountRef)
	if err != nil {
		return nil, err
	}
	if !bound || client == nil {
		return nil, nil
	}
	return client, nil
}
