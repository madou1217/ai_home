package proxyingress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"
)

const (
	// DefaultMaxHeaderBytes bounds inbound HTTP request heads.
	DefaultMaxHeaderBytes = 64 << 10
	// DefaultHandshakeTimeout bounds HTTP request heads and SOCKS5 handshakes.
	DefaultHandshakeTimeout = 10 * time.Second
	// DefaultDialTimeout bounds a single upstream lease dial.
	DefaultDialTimeout = 15 * time.Second
	// DefaultShutdownTimeout bounds how long Close waits for connections.
	DefaultShutdownTimeout = 5 * time.Second

	maxAllowedHeaderBytes  = 1 << 20
	loopbackListenAddress  = "127.0.0.1:0"
	socksReadBufferSize    = 32 << 10
	upstreamReadBufferSize = 16 << 10
)

var (
	// ErrClosed reports that the ingress no longer accepts connections.
	ErrClosed = errors.New("proxyingress: ingress is closed")
	// ErrShutdownTimeout reports that Close could not drain every connection.
	ErrShutdownTimeout = errors.New("proxyingress: shutdown timed out")
	// ErrDialTimeout reports that the upstream lease dial exceeded DialTimeout.
	ErrDialTimeout = errors.New("proxyingress: upstream dial timed out")
)

// Credentials authenticate local clients. Both fields are required.
type Credentials struct {
	Username string
	Password string
}

// Dial opens one stream to the upstream lease endpoint. It is called
// concurrently and must honor context cancellation.
type Dial func(ctx context.Context) (io.ReadWriteCloser, error)

// Config configures an Ingress. At least one of HTTP or SOCKS5 must be true.
type Config struct {
	Dial        Dial
	Credentials Credentials
	HTTP        bool
	SOCKS5      bool
	// AllowAnonymous 让 loopback 客户端不携带凭据即可使用 HTTP 与 SOCKS5。
	// 入口只监听 127.0.0.1；上游仍然使用 Credentials 生成租约认证。
	AllowAnonymous bool
	// HTTPListenAddress / SOCKSListenAddress 是监听地址；空值监听 127.0.0.1:0。
	HTTPListenAddress  string
	SOCKSListenAddress string
	MaxHeaderBytes     int
	HandshakeTimeout   time.Duration
	DialTimeout        time.Duration
	ShutdownTimeout    time.Duration
}

func normalizeConfig(config Config) (Config, error) {
	if config.Dial == nil {
		return Config{}, errors.New("proxyingress: Dial is required")
	}
	if !config.HTTP && !config.SOCKS5 {
		return Config{}, errors.New("proxyingress: enable HTTP, SOCKS5, or both")
	}
	if err := validateCredentials(config.Credentials); err != nil {
		return Config{}, err
	}
	if config.SOCKS5 && (len(config.Credentials.Username) > 255 || len(config.Credentials.Password) > 255) {
		return Config{}, errors.New("proxyingress: SOCKS5 credentials must not exceed 255 bytes")
	}
	switch {
	case config.MaxHeaderBytes == 0:
		config.MaxHeaderBytes = DefaultMaxHeaderBytes
	case config.MaxHeaderBytes < 0 || config.MaxHeaderBytes > maxAllowedHeaderBytes:
		return Config{}, fmt.Errorf("proxyingress: MaxHeaderBytes must be between 1 and %d", maxAllowedHeaderBytes)
	}
	if config.HandshakeTimeout == 0 {
		config.HandshakeTimeout = DefaultHandshakeTimeout
	} else if config.HandshakeTimeout < 0 {
		return Config{}, errors.New("proxyingress: HandshakeTimeout must not be negative")
	}
	if config.DialTimeout == 0 {
		config.DialTimeout = DefaultDialTimeout
	} else if config.DialTimeout < 0 {
		return Config{}, errors.New("proxyingress: DialTimeout must not be negative")
	}
	if config.ShutdownTimeout == 0 {
		config.ShutdownTimeout = DefaultShutdownTimeout
	} else if config.ShutdownTimeout < 0 {
		return Config{}, errors.New("proxyingress: ShutdownTimeout must not be negative")
	}
	if config.HTTPListenAddress = strings.TrimSpace(config.HTTPListenAddress); config.HTTPListenAddress == "" {
		config.HTTPListenAddress = loopbackListenAddress
	}
	if config.SOCKSListenAddress = strings.TrimSpace(config.SOCKSListenAddress); config.SOCKSListenAddress == "" {
		config.SOCKSListenAddress = loopbackListenAddress
	}
	if !isLoopbackListenAddress(config.HTTPListenAddress) || !isLoopbackListenAddress(config.SOCKSListenAddress) {
		return Config{}, errors.New("proxyingress: listeners must bind loopback")
	}
	return config, nil
}

func isLoopbackListenAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "::1" || strings.EqualFold(host, "localhost")
}

func validateCredentials(credentials Credentials) error {
	if credentials.Username == "" || credentials.Password == "" {
		return errors.New("proxyingress: credentials username and password are required")
	}
	if strings.ContainsRune(credentials.Username, ':') {
		return errors.New("proxyingress: credentials username must not contain ':'")
	}
	if strings.ContainsAny(credentials.Username+credentials.Password, "\x00\r\n") {
		return errors.New("proxyingress: credentials must not contain control characters")
	}
	return nil
}

func credentialURL(scheme, address string, credentials Credentials, anonymous bool) string {
	if anonymous {
		return (&url.URL{Scheme: scheme, Host: address}).String()
	}
	return (&url.URL{
		Scheme: scheme,
		Host:   address,
		User:   url.UserPassword(credentials.Username, credentials.Password),
	}).String()
}
