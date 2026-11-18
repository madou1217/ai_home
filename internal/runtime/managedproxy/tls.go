package managedproxy

import (
	"context"
	"crypto/tls"
	"net"
)

func tlsProxy(ctx context.Context, connection net.Conn, host string) (net.Conn, error) {
	secured := tls.Client(connection, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err := secured.HandshakeContext(ctx); err != nil {
		connection.Close()
		return nil, err
	}
	return secured, nil
}
