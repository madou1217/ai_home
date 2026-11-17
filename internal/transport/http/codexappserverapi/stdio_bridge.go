package codexappserverapi

import (
	"context"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

type StdioBridgeOptions struct {
	Rewrite       codexappserverws.RewriteOptions
	MaxFrameBytes int
	LogDebug      func(string)
	LogError      func(error)
}

type websocketFrameTransport struct{ conn *websocket.Conn }

func (frames websocketFrameTransport) Read(ctx context.Context) ([]byte, error) {
	_, raw, err := frames.conn.Read(ctx)
	return raw, err
}

func (frames websocketFrameTransport) Write(ctx context.Context, raw []byte) error {
	return frames.conn.Write(ctx, websocket.MessageText, raw)
}

func (frames websocketFrameTransport) Close() error { return frames.conn.CloseNow() }

// BridgeAppServerStdio preserves the gateway/local-TUI WS adapter contract;
// the native RPC frame ordering and lifecycle now have one transport-neutral
// owner shared with future caller-scoped frontends.
func BridgeAppServerStdio(parent context.Context, conn *websocket.Conn, stdio *StdioSession, options StdioBridgeOptions) {
	limit := options.MaxFrameBytes
	if limit <= 0 {
		limit = maxAppServerLineBytes
	}
	conn.SetReadLimit(int64(limit))
	codexappserverws.BridgeStdio(parent, websocketFrameTransport{conn}, &codexappserverws.StdioBridgeSession{
		Stdin: stdio.Stdin, Stdout: stdio.Stdout, Stderr: stdio.Stderr,
		Wait: stdio.Wait, Close: stdio.Close,
	}, codexappserverws.FrameBridgeOptions{
		Rewrite: options.Rewrite, MaxFrameBytes: limit,
		LogDebug: options.LogDebug, LogError: options.LogError,
	})
}
