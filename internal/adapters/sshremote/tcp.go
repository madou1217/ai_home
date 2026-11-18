package sshremote

import (
	"context"
	"fmt"
	"net"
)

// DialTCP opens a direct-tcpip channel without executing anything remotely.
func (client *Client) DialTCP(ctx context.Context, network, address string) (net.Conn, error) {
	if client == nil || client.client == nil {
		return nil, fmt.Errorf("SSH connection unavailable")
	}
	return client.client.DialContext(ctx, network, address)
}

func (client *Client) Wait() error {
	if client == nil || client.client == nil {
		return fmt.Errorf("SSH unavailable")
	}
	return client.client.Wait()
}

func (client *Client) KeepAlive(ctx context.Context) error {
	done := make(chan error, 1)
	go func() { _, _, err := client.client.SendRequest("keepalive@openssh.com", true, nil); done <- err }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
