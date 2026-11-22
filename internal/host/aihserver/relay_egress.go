package aihserver

import (
	"context"
	"time"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/transport/http/relayegress"
)

// relayAccountEgress 把账号出口绑定投影到透传通道的上游请求。
//
// 解析与连接池复用 accountEgressClients；这里只把结果适配成 relayegress 端口。
type relayAccountEgress struct {
	clients *accountEgressClients
}

func newRelayAccountEgress(manager func() *runtimeegress.Manager, timeout time.Duration) *relayAccountEgress {
	return &relayAccountEgress{clients: newAccountEgressClients(manager, timeout)}
}

// ClientForAccount 返回账号绑定对应的客户端；bound=false 表示未绑定。
func (resolver *relayAccountEgress) ClientForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (relayegress.HTTPClient, bool, error) {
	client, bound, err := resolver.clients.clientForAccount(ctx, provider, accountRef)
	if err != nil || client == nil {
		return nil, bound, err
	}
	return client, true, nil
}
