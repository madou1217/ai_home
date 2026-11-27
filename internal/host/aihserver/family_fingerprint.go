package aihserver

import (
	"context"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// newFamilyFingerprintHTTPClient 为家族透传通道构造独立客户端：
// 家族推理 host 使用官方 CLI 的 ClientHello 与 HTTP/1.1 头部顺序，
// 其它 host 沿用普通 transport。不能复用 Claude Relay 的客户端，
// 那条通道不应被家族指纹改变。
func newFamilyFingerprintHTTPClient() relaycore.HTTPClient {
	return &http.Client{
		Transport:     codebuddyfamilyrelay.NewHostRoutingRoundTripper(newUpstreamTransport()),
		Timeout:       claudeRelayHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
}

// familyFingerprintEgress 在账号出口客户端上追加家族指纹；没有出口绑定
// 或客户端不是标准 *http.Client 时原样透传，保证出口语义不被破坏。
type familyFingerprintEgress struct {
	base relaycore.AccountEgress
}

func (egress familyFingerprintEgress) ClientForAccount(
	ctx context.Context,
	provider string,
	accountRef string,
) (relaycore.HTTPClient, bool, error) {
	client, bound, err := egress.base.ClientForAccount(ctx, provider, accountRef)
	if err != nil || client == nil {
		return client, bound, err
	}
	return newFamilyFingerprintClient(client), bound, nil
}

func newFamilyFingerprintClient(base relaycore.HTTPClient) relaycore.HTTPClient {
	client, ok := base.(*http.Client)
	if !ok || client == nil {
		return base
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport == nil {
		return base
	}
	clone := *client
	clone.Transport = codebuddyfamilyrelay.NewHostRoutingRoundTripper(transport)
	return &clone
}
