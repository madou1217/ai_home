//go:build !windows

package pluginruntime

import "net"

func listenFakeHost(address string) (net.Listener, error) {
	return net.Listen("unix", address)
}
