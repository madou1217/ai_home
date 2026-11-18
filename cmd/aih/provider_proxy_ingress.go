package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The task ingress is loopback-only, authenticated with the lease token. Management
// credentials are never passed to the installer or forwarded inside proxy data.
// A successful CONNECT remains a byte stream; HTTPS certificates are untouched.
type providerProxyIngress struct {
	URL         string
	auth        string
	listener    net.Listener
	ctx         context.Context
	cancel      context.CancelFunc
	connect     func(context.Context) (io.ReadWriteCloser, error)
	mu          sync.Mutex
	connections map[io.Closer]struct{}
	closed      bool
	workers     sync.WaitGroup
	once        sync.Once
}

func newProviderProxyIngress(parent context.Context, credentials *url.Userinfo, connect func(context.Context) (io.ReadWriteCloser, error)) (*providerProxyIngress, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	secret, _ := credentials.Password()
	address := &url.URL{Scheme: "http", Host: listener.Addr().String(), User: credentials}
	ingress := &providerProxyIngress{URL: address.String(), auth: "Basic " + base64.StdEncoding.EncodeToString([]byte(credentials.Username()+":"+secret)), listener: listener, ctx: ctx, cancel: cancel, connect: connect, connections: make(map[io.Closer]struct{})}
	ingress.workers.Add(1)
	go func() {
		defer ingress.workers.Done()
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			if !ingress.track(connection) {
				continue
			}
			ingress.workers.Add(1)
			go func() { defer ingress.workers.Done(); ingress.serve(connection) }()
		}
	}()
	go func() { <-ctx.Done(); ingress.Close() }()
	return ingress, nil
}

func (ingress *providerProxyIngress) track(connection io.Closer) bool {
	ingress.mu.Lock()
	defer ingress.mu.Unlock()
	if ingress.closed {
		connection.Close()
		return false
	}
	ingress.connections[connection] = struct{}{}
	return true
}

func (ingress *providerProxyIngress) forget(connection io.Closer) {
	connection.Close()
	ingress.mu.Lock()
	delete(ingress.connections, connection)
	ingress.mu.Unlock()
}

func (ingress *providerProxyIngress) Close() {
	ingress.once.Do(func() {
		ingress.cancel()
		ingress.listener.Close()
		ingress.mu.Lock()
		ingress.closed = true
		for connection := range ingress.connections {
			connection.Close()
		}
		ingress.mu.Unlock()
		ingress.workers.Wait()
	})
}

func (ingress *providerProxyIngress) serve(connection net.Conn) {
	defer ingress.forget(connection)
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReaderSize(connection, 64*1024)
	var header bytes.Buffer
	for header.Len() < 64*1024 {
		line, err := reader.ReadSlice('\n')
		if err != nil || header.Len()+len(line) > 64*1024 {
			return
		}
		if header.Len() > 0 && (line[0] == ' ' || line[0] == '\t') {
			return
		}
		header.Write(line)
		if string(line) == "\r\n" {
			break
		}
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header.Bytes())))
	if err != nil {
		_, _ = io.WriteString(connection, "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return
	}
	provided := request.Header.Values("Proxy-Authorization")
	if len(provided) != 1 || subtle.ConstantTimeCompare([]byte(provided[0]), []byte(ingress.auth)) != 1 {
		_, _ = io.WriteString(connection, "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"aih-task\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return
	}
	stream, err := ingress.connect(ingress.ctx)
	if err != nil {
		_, _ = io.WriteString(connection, "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return
	}
	if !ingress.track(stream) {
		return
	}
	defer ingress.forget(stream)
	// Preserve the exact request framing and any already-buffered body bytes.
	// The lease Proxy-Authorization must reach the credential-protected server
	// proxy. Only its token (never the management key) travels in the raw stream.
	// Plain HTTP uses one request per connection, authenticating each request.
	lines := strings.Split(header.String(), "\r\n")
	var forwarded strings.Builder
	forwarded.WriteString(lines[0] + "\r\n")
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		name, _, _ := strings.Cut(line, ":")
		if strings.EqualFold(name, "Proxy-Connection") {
			continue
		}
		if request.Method != http.MethodConnect && strings.EqualFold(name, "Connection") {
			continue
		}
		forwarded.WriteString(line + "\r\n")
	}
	if request.Method != http.MethodConnect {
		forwarded.WriteString("Connection: close\r\n")
	}
	forwarded.WriteString("\r\n")
	if _, err := io.WriteString(stream, forwarded.String()); err != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	done := make(chan struct{})
	go func() { _, _ = io.Copy(stream, reader); stream.Close(); close(done) }()
	_, _ = io.Copy(connection, stream)
	connection.Close()
	stream.Close()
	<-done
}
