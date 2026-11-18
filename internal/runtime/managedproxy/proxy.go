// Package managedproxy provides a bounded HTTP proxy over an injected dialer.
package managedproxy

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Dialer func(context.Context, string, string) (net.Conn, error)

type Handler struct {
	Dial           Dialer
	Token          string
	OnTunnelClosed func(net.Conn)
	Resolve        func(context.Context, string) (string, error)
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Token != "" {
		expected := "Basic " + base64.StdEncoding.EncodeToString([]byte("aih:"+h.Token))
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(expected)) != 1 {
			w.Header().Set("Proxy-Authenticate", `Basic realm="aih-managed"`)
			http.Error(w, "proxy authentication required", 407)
			return
		}
	}
	if h.Dial == nil {
		http.Error(w, "proxy unavailable", 503)
		return
	}
	if r.Method == http.MethodConnect {
		h.connect(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "absolute HTTP URL required", 400)
		return
	}
	address, err := Address(r.URL.Host, "80")
	if err != nil {
		http.Error(w, "destination not allowed", 403)
		return
	}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		literal, err := h.publicAddress(ctx, address)
		if err != nil {
			return nil, err
		}
		return h.Dial(ctx, network, literal)
	}, DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	request := r.Clone(r.Context())
	request.RequestURI = ""
	request.Header = request.Header.Clone()
	request.Header.Del("Proxy-Authorization")
	request.Header.Del("Proxy-Connection")
	request.Header.Del("Connection")
	response, err := transport.RoundTrip(request)
	if err != nil {
		http.Error(w, "upstream unavailable", 502)
		return
	}
	defer response.Body.Close()
	for k, values := range response.Header {
		if strings.EqualFold(k, "Connection") || strings.EqualFold(k, "Proxy-Authenticate") {
			continue
		}
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func Address(host, defaultPort string) (string, error) {
	if !strings.Contains(host, ":") {
		host = net.JoinHostPort(host, defaultPort)
	}
	name, port, err := net.SplitHostPort(host)
	if err != nil || name == "" || (port != "80" && port != "443") || strings.ContainsAny(name, "\r\n\x00") {
		return "", fmt.Errorf("destination not allowed")
	}
	// Never let a managed public-network outlet reach cloud metadata/loopback.
	if strings.EqualFold(name, "localhost") || strings.HasSuffix(strings.ToLower(name), ".localhost") {
		return "", fmt.Errorf("private destination")
	}
	if ip := net.ParseIP(name); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast()) {
		return "", fmt.Errorf("private destination")
	}
	return net.JoinHostPort(name, port), nil
}

func (h Handler) connect(w http.ResponseWriter, r *http.Request) {
	address, err := Address(r.Host, "443")
	if err != nil {
		http.Error(w, "destination not allowed", 403)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	literal, err := h.publicAddress(ctx, address)
	if err != nil {
		http.Error(w, "destination not allowed", 403)
		return
	}
	upstream, err := h.Dial(ctx, "tcp", literal)
	if err != nil {
		http.Error(w, "SSH outlet unavailable", 502)
		return
	}
	client, buffer, err := http.NewResponseController(w).Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	if h.OnTunnelClosed != nil {
		defer h.OnTunnelClosed(client)
	}
	if _, err = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err == nil {
		err = buffer.Flush()
	}
	if err != nil {
		client.Close()
		upstream.Close()
		return
	}
	Pipe(client, upstream, buffer.Reader)
}

// Pipe closes both ends when either direction ends; buffered bytes are retained.
func Pipe(left, right net.Conn, leftReader io.Reader) {
	if leftReader == nil {
		leftReader = left
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(right, leftReader); done <- struct{}{} }()
	go func() { _, _ = io.Copy(left, right); done <- struct{}{} }()
	<-done
	_ = left.Close()
	_ = right.Close()
	<-done
}

// ProxyDial tunnels TCP through an existing HTTP(S) proxy using CONNECT.
func ProxyDial(ctx context.Context, proxy *url.URL, address string) (net.Conn, error) {
	dial := net.Dialer{Timeout: 15 * time.Second}
	host := proxy.Host
	if proxy.Port() == "" {
		port := "80"
		if proxy.Scheme == "https" {
			port = "443"
		}
		host = net.JoinHostPort(proxy.Hostname(), port)
	}
	connection, err := dial.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, err
	}
	return connectProxy(ctx, connection, proxy, address)
}

func connectProxy(ctx context.Context, connection net.Conn, proxy *url.URL, address string) (net.Conn, error) {
	if proxy.Scheme == "https" {
		var err error
		connection, err = tlsProxy(ctx, connection, proxy.Hostname())
		if err != nil {
			return nil, err
		}
	}
	_ = connection.SetDeadline(time.Now().Add(20 * time.Second))
	request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: address}, Host: address, Header: make(http.Header)}
	if proxy.User != nil {
		password, _ := proxy.User.Password()
		request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(proxy.User.Username()+":"+password)))
	}
	if err := request.Write(connection); err != nil {
		connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		connection.Close()
		return nil, err
	}
	if response.StatusCode != 200 {
		connection.Close()
		return nil, fmt.Errorf("proxy CONNECT status %d", response.StatusCode)
	}
	_ = connection.SetDeadline(time.Time{})
	return &bufferedConn{Conn: connection, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func (h Handler) publicAddress(ctx context.Context, address string) (string, error) {
	if h.Resolve != nil {
		return h.Resolve(ctx, address)
	}
	return PublicAddress(ctx, address)
}
