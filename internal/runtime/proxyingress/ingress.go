package proxyingress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Ingress owns loopback HTTP and/or SOCKS5 listeners. URLs returned by the
// accessors embed credentials and must not be logged. Close is idempotent.
type Ingress struct {
	dial               Dial
	credentials        Credentials
	authorization      string
	authorizationValue string
	maxHeaderBytes     int
	handshakeTimeout   time.Duration
	dialTimeout        time.Duration
	shutdownTimeout    time.Duration

	httpTransport *http.Transport
	httpServer    *http.Server
	httpListener  net.Listener
	socksListener net.Listener
	httpAddress   string
	socksAddress  string
	httpURL       string
	socksURL      string

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	mu      sync.Mutex
	closed  bool
	clients map[*trackedConn]struct{}
	streams map[*trackedStream]struct{}
	wg      sync.WaitGroup

	active    atomic.Int64
	closeOnce sync.Once
	closeErr  error
}

// Start binds the requested loopback listeners and begins serving. The parent
// context controls the lifetime; canceling it closes the ingress.
func Start(ctx context.Context, config Config) (*Ingress, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}

	lifetime, cancel := context.WithCancel(ctx)
	encoded := encodeBasic(normalized.Credentials)
	ingress := &Ingress{
		dial:               normalized.Dial,
		credentials:        normalized.Credentials,
		authorization:      "Basic " + encoded,
		authorizationValue: encoded,
		maxHeaderBytes:     normalized.MaxHeaderBytes,
		handshakeTimeout:   normalized.HandshakeTimeout,
		dialTimeout:        normalized.DialTimeout,
		shutdownTimeout:    normalized.ShutdownTimeout,
		ctx:                lifetime,
		cancel:             cancel,
		done:               make(chan struct{}),
		clients:            map[*trackedConn]struct{}{},
		streams:            map[*trackedStream]struct{}{},
	}

	var httpListener net.Listener
	var socksListener net.Listener
	if normalized.HTTP {
		httpListener, err = net.Listen("tcp", loopbackListenAddress)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("proxyingress: listen http: %w", err)
		}
	}
	if normalized.SOCKS5 {
		socksListener, err = net.Listen("tcp", loopbackListenAddress)
		if err != nil {
			if httpListener != nil {
				_ = httpListener.Close()
			}
			cancel()
			return nil, fmt.Errorf("proxyingress: listen socks5: %w", err)
		}
	}

	ingress.httpListener = httpListener
	ingress.socksListener = socksListener
	if httpListener != nil {
		ingress.httpAddress = httpListener.Addr().String()
		ingress.httpURL = credentialURL("http", ingress.httpAddress, normalized.Credentials)
		ingress.httpServer = &http.Server{
			Handler:           http.HandlerFunc(ingress.serveHTTP),
			ReadHeaderTimeout: normalized.HandshakeTimeout,
			MaxHeaderBytes:    normalized.MaxHeaderBytes,
		}
		ingress.httpTransport = ingress.newHTTPTransport()
	}
	if socksListener != nil {
		ingress.socksAddress = socksListener.Addr().String()
		ingress.socksURL = credentialURL("socks5", ingress.socksAddress, normalized.Credentials)
	}

	go ingress.watch(lifetime)
	if ingress.httpServer != nil {
		listener := &trackingListener{Listener: ingress.httpListener, ingress: ingress}
		go func() {
			_ = ingress.httpServer.Serve(listener)
		}()
	}
	if ingress.socksListener != nil {
		go ingress.serveSOCKS()
	}
	return ingress, nil
}

func (i *Ingress) watch(ctx context.Context) {
	select {
	case <-ctx.Done():
		_ = i.Close()
	case <-i.done:
	}
}

// HTTPAddress returns the loopback host:port of the HTTP listener, or "" when
// HTTP is disabled.
func (i *Ingress) HTTPAddress() string {
	if i == nil {
		return ""
	}
	return i.httpAddress
}

// SOCKS5Address returns the loopback host:port of the SOCKS5 listener, or ""
// when SOCKS5 is disabled.
func (i *Ingress) SOCKS5Address() string {
	if i == nil {
		return ""
	}
	return i.socksAddress
}

// HTTPURL returns the authenticated HTTP proxy URL, or "" when HTTP is
// disabled. The URL embeds credentials and must never be logged.
func (i *Ingress) HTTPURL() string {
	if i == nil {
		return ""
	}
	return i.httpURL
}

// SOCKS5URL returns the authenticated SOCKS5 proxy URL, or "" when SOCKS5 is
// disabled. The URL embeds credentials and must never be logged.
func (i *Ingress) SOCKS5URL() string {
	if i == nil {
		return ""
	}
	return i.socksURL
}

// ActiveConnections reports the number of live client proxy connections.
func (i *Ingress) ActiveConnections() int {
	if i == nil {
		return 0
	}
	return int(i.active.Load())
}

// Close stops both listeners, closes live connections, and waits for handlers.
// Repeated calls return the same result.
func (i *Ingress) Close() error {
	if i == nil {
		return nil
	}
	i.closeOnce.Do(func() {
		i.cancel()
		i.mu.Lock()
		i.closed = true
		i.mu.Unlock()
		close(i.done)

		if i.httpServer != nil {
			_ = i.httpServer.Close()
		}
		if i.socksListener != nil {
			_ = i.socksListener.Close()
		}
		if i.httpTransport != nil {
			i.httpTransport.CloseIdleConnections()
		}

		i.mu.Lock()
		clients := make([]*trackedConn, 0, len(i.clients))
		for connection := range i.clients {
			clients = append(clients, connection)
		}
		streams := make([]*trackedStream, 0, len(i.streams))
		for stream := range i.streams {
			streams = append(streams, stream)
		}
		i.mu.Unlock()

		// Bound the whole drain: a misbehaving stream Close must not make
		// Ingress.Close hang past ShutdownTimeout.
		drained := make(chan struct{})
		go func() {
			for _, connection := range clients {
				_ = connection.Close()
			}
			for _, stream := range streams {
				_ = stream.Close()
			}
			i.wg.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-time.After(i.shutdownTimeout):
			i.closeErr = ErrShutdownTimeout
		}
	})
	return i.closeErr
}

func (i *Ingress) isClosed() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.closed
}

func (i *Ingress) serveSOCKS() {
	for {
		connection, err := i.socksListener.Accept()
		if err != nil {
			if i.isClosed() || errors.Is(err, net.ErrClosed) {
				return
			}
			// A transient accept failure must not spin or stop the listener.
			time.Sleep(10 * time.Millisecond)
			continue
		}
		tracked, ok := i.trackClient(connection)
		if !ok {
			continue
		}
		go func() {
			defer tracked.Close()
			i.serveSOCKSConn(tracked)
		}()
	}
}
