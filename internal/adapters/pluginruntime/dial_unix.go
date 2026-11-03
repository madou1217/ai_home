//go:build !windows

package pluginruntime

import (
	"context"
	"net"
)

func dialHost(ctx context.Context, address string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", address)
}
