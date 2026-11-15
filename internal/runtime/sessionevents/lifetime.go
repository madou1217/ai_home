package sessionevents

import "context"

// NewBusWithContext closes watchers and subscriptions when the owning host ends.
// Explicit Close unregisters the callback, so repeated embedded hosts do not
// retain completed buses until a longer-lived parent eventually exits.
func NewBusWithContext(parent context.Context, options BusOptions) *Bus {
	bus := NewBus(options)
	if parent != nil {
		bus.mu.Lock()
		bus.stopLifetime = context.AfterFunc(parent, bus.Close)
		bus.mu.Unlock()
	}
	return bus
}

// Context exposes only cancellation of the shared bus, not the host's values.
func (bus *Bus) Context() context.Context { return bus.lifetime }

// Done includes connections waiting for authentication before they subscribe.
func (bus *Bus) Done() <-chan struct{} { return bus.lifetime.Done() }
