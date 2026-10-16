//go:build windows

package pluginruntime

import (
	"net"

	"github.com/Microsoft/go-winio"
)

// listenFakeHost 在 Windows 上用 named pipe 承载最小对端，与 dial_windows.go 的传输一致。
func listenFakeHost(address string) (net.Listener, error) {
	return winio.ListenPipe(address, nil)
}
