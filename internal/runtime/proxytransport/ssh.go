package proxytransport

import "context"

// SSH 是经由已认证 SSH 连接（direct-tcpip）到达远端 loopback 管理面的
// Transport。它只搬运字节，从不执行远端命令。
//
// 连接器的所有权转移给 SSH：Close 会关闭底层 *sshremote.Client。需要共享
// 客户端时，传入一个 Close 无副作用的包装类型。
type SSH struct {
	forward *loopbackForwarder
}

// NewSSH 绑定本地 loopback 监听，并把每个接入连接经 connector.DialTCP
// 转发到 options.RemoteAddress。
//
// connector 通常是已经拨号完成的 *sshremote.Client；它满足 Connector，
// 因为该接口只要求 DialTCP 与 Close。失败时不会接管 connector，调用方仍
// 需自行关闭；成功后由 SSH.Close 负责。
func NewSSH(ctx context.Context, connector Connector, options SSHOptions) (*SSH, error) {
	forward, err := newForwarder(ctx, connector, options.RemoteAddress, options.ListenAddress)
	if err != nil {
		return nil, err
	}
	return &SSH{forward: forward}, nil
}

// BaseURL 返回 http://<loopback>:<port>。
func (transport *SSH) BaseURL() string {
	if transport == nil || transport.forward == nil {
		return ""
	}
	return transport.forward.BaseURL()
}

// Close 释放监听、在途连接与 SSH 连接；幂等。
func (transport *SSH) Close() error {
	if transport == nil || transport.forward == nil {
		return nil
	}
	return transport.forward.Close()
}
