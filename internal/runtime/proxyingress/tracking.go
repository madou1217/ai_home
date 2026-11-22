package proxyingress

import (
	"io"
	"net"
	"sync"
	"time"
)

func (i *Ingress) trackClient(connection net.Conn) (*trackedConn, bool) {
	i.mu.Lock()
	if i.closed {
		i.mu.Unlock()
		_ = connection.Close()
		return nil, false
	}
	tracked := &trackedConn{Conn: connection}
	tracked.onClose = func() { i.releaseClient(tracked) }
	i.clients[tracked] = struct{}{}
	i.active.Add(1)
	i.wg.Add(1)
	i.mu.Unlock()
	return tracked, true
}

func (i *Ingress) releaseClient(connection *trackedConn) {
	i.mu.Lock()
	delete(i.clients, connection)
	i.mu.Unlock()
	i.active.Add(-1)
	i.wg.Done()
}

func (i *Ingress) trackStream(stream io.ReadWriteCloser) (*trackedStream, bool) {
	i.mu.Lock()
	if i.closed {
		i.mu.Unlock()
		_ = stream.Close()
		return nil, false
	}
	tracked := &trackedStream{ReadWriteCloser: stream}
	tracked.onClose = func() { i.releaseStream(tracked) }
	i.streams[tracked] = struct{}{}
	i.wg.Add(1)
	i.mu.Unlock()
	return tracked, true
}

func (i *Ingress) releaseStream(stream *trackedStream) {
	i.mu.Lock()
	delete(i.streams, stream)
	i.mu.Unlock()
	i.wg.Done()
}

// trackedConn releases ingress bookkeeping when the underlying client
// connection closes, regardless of which layer closes it first.
type trackedConn struct {
	net.Conn
	once    sync.Once
	err     error
	onClose func()
}

func (connection *trackedConn) Close() error {
	connection.once.Do(func() {
		connection.err = connection.Conn.Close()
		if connection.onClose != nil {
			connection.onClose()
		}
	})
	return connection.err
}

// trackedStream does the same for an upstream lease stream.
type trackedStream struct {
	io.ReadWriteCloser
	once    sync.Once
	err     error
	onClose func()
}

func (stream *trackedStream) Close() error {
	stream.once.Do(func() {
		stream.err = stream.ReadWriteCloser.Close()
		if stream.onClose != nil {
			stream.onClose()
		}
	})
	return stream.err
}

type trackingListener struct {
	net.Listener
	ingress *Ingress
}

func (listener *trackingListener) Accept() (net.Conn, error) {
	connection, err := listener.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked, ok := listener.ingress.trackClient(connection)
	if !ok {
		return nil, net.ErrClosed
	}
	return tracked, nil
}

// streamConn adapts an opaque lease stream to net.Conn for net/http. Deadlines
// are forwarded only when the stream implements them.
type streamConn struct {
	stream io.ReadWriteCloser
}

func (connection *streamConn) Read(payload []byte) (int, error) {
	return connection.stream.Read(payload)
}

func (connection *streamConn) Write(payload []byte) (int, error) {
	return connection.stream.Write(payload)
}

func (connection *streamConn) Close() error {
	return connection.stream.Close()
}

func (connection *streamConn) LocalAddr() net.Addr {
	return streamAddress("local")
}

func (connection *streamConn) RemoteAddr() net.Addr {
	return streamAddress("upstream")
}

func (connection *streamConn) SetDeadline(deadline time.Time) error {
	if setter, ok := connection.stream.(interface{ SetDeadline(time.Time) error }); ok {
		return setter.SetDeadline(deadline)
	}
	return nil
}

func (connection *streamConn) SetReadDeadline(deadline time.Time) error {
	if setter, ok := connection.stream.(interface{ SetReadDeadline(time.Time) error }); ok {
		return setter.SetReadDeadline(deadline)
	}
	return nil
}

func (connection *streamConn) SetWriteDeadline(deadline time.Time) error {
	if setter, ok := connection.stream.(interface{ SetWriteDeadline(time.Time) error }); ok {
		return setter.SetWriteDeadline(deadline)
	}
	return nil
}

type streamAddress string

func (address streamAddress) Network() string {
	return "stream"
}

func (address streamAddress) String() string {
	return string(address)
}
