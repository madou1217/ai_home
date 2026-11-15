package aihserver

import (
	"context"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

func newManagedSessionEventBus(ctx context.Context, options sessionevents.BusOptions) *sessionevents.Bus {
	return sessionevents.NewBusWithContext(ctx, options)
}

// The bus predates io.Closer; keep its public Close signature while giving the
// host one explicit lifecycle owner for SSE, WebSocket and fsnotify resources.
type sessionEventBusCloser struct{ bus *sessionevents.Bus }

func (closer sessionEventBusCloser) Close() error {
	if closer.bus != nil {
		closer.bus.Close()
	}
	return nil
}
