//go:build windows

package pluginruntime

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

// named pipe 必须用重叠 I/O 打开：os.OpenFile 得到的同步句柄在读阻塞时会让写也排队，读写并发即死锁。
func dialHost(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}
