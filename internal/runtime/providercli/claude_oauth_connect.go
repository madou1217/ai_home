package providercli

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// claudeOAuthCertificateLifetime 覆盖长期持久 CLI 会话，但证书仍随单次 Runtime 销毁。
const claudeOAuthCertificateLifetime = 365 * 24 * time.Hour

// serveConnect 终止 Claude Code Unix Socket 上的受信 TLS，并把内层 HTTP 交回 OAuth 代理。
func (proxy *claudeOAuthProxy) serveConnect(writer http.ResponseWriter, request *http.Request) {
	if proxy == nil || proxy.tlsConfig == nil || !proxy.isAllowedConnectTarget(request.Host) {
		writeProxyError(writer, http.StatusForbidden, "CONNECT target is not allowed")
		return
	}
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		writeProxyError(writer, http.StatusInternalServerError, "connection hijacking is unavailable")
		return
	}
	connection, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = connection.Close()
		return
	}
	if err := buffered.Flush(); err != nil {
		_ = connection.Close()
		return
	}
	bufferedConnection := &readBufferedConnection{Conn: connection, reader: buffered.Reader}
	tlsConnection := tls.Server(bufferedConnection, proxy.tlsConfig.Clone())
	if err := tlsConnection.HandshakeContext(request.Context()); err != nil {
		_ = tlsConnection.Close()
		return
	}
	innerListener := newSingleConnectionListener(tlsConnection)
	innerServer := &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 10 * time.Second,
	}
	_ = innerServer.Serve(innerListener)
}

// isAllowedConnectTarget 确保 Unix Socket 不能被滥用为任意目标的本地代理。
func (proxy *claudeOAuthProxy) isAllowedConnectTarget(authority string) bool {
	if proxy == nil || proxy.target == nil {
		return false
	}
	host, port := splitConnectAuthority(authority)
	targetPort := proxy.target.Port()
	if targetPort == "" {
		targetPort = "443"
	}
	return strings.EqualFold(strings.TrimSuffix(host, "."), proxy.target.Hostname()) &&
		port == targetPort
}

// splitConnectAuthority 兼容 Claude Code 当前省略 443 的 CONNECT authority。
func splitConnectAuthority(authority string) (string, string) {
	if host, port, err := net.SplitHostPort(authority); err == nil {
		return host, port
	}
	return authority, "443"
}

// newClaudeOAuthTLSConfig 创建只在本次 CLI 生命周期内有效的内存 CA 与服务证书。
func newClaudeOAuthTLSConfig(host string, now time.Time) (*tls.Config, []byte, error) {
	caPrivateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	caSerial, err := randomCertificateSerial()
	if err != nil {
		return nil, nil, err
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          caSerial,
		Subject:               pkix.Name{CommonName: "aih Claude OAuth 临时 CA"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(claudeOAuthCertificateLifetime),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caPrivateKey.PublicKey, caPrivateKey)
	if err != nil {
		return nil, nil, err
	}
	leafPrivateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	leafSerial, err := randomCertificateSerial()
	if err != nil {
		return nil, nil, err
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: leafSerial,
		Subject:      pkix.Name{CommonName: host},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(claudeOAuthCertificateLifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	if ip := net.ParseIP(host); ip != nil {
		leafTemplate.IPAddresses = []net.IP{ip}
	} else {
		leafTemplate.DNSNames = []string{host}
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caTemplate, &leafPrivateKey.PublicKey, caPrivateKey)
	if err != nil {
		return nil, nil, err
	}
	leafPrivateKeyDER, err := x509.MarshalPKCS8PrivateKey(leafPrivateKey)
	if err != nil {
		return nil, nil, err
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafPrivateKeyDER}),
	)
	if err != nil {
		return nil, nil, err
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		NextProtos:   []string{"http/1.1"},
		Certificates: []tls.Certificate{certificate},
	}, caPEM, nil
}

// randomCertificateSerial 返回不带业务含义的 128 位随机证书序列号。
func randomCertificateSerial() (*big.Int, error) {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	return rand.Int(rand.Reader, limit)
}

// loadClaudeOAuthCABundle 保留调用方已有 CA，并追加本次 Unix Socket 临时 CA。
func loadClaudeOAuthCABundle(caCertificate []byte, environment []string) []byte {
	existingPath, found := environmentValue(environment, "NODE_EXTRA_CA_CERTS")
	if !found || strings.TrimSpace(existingPath) == "" {
		return append([]byte(nil), caCertificate...)
	}
	existing, err := os.ReadFile(existingPath)
	if err != nil || len(existing) == 0 {
		return append([]byte(nil), caCertificate...)
	}
	bundle := append([]byte(nil), existing...)
	if bundle[len(bundle)-1] != '\n' {
		bundle = append(bundle, '\n')
	}
	return append(bundle, caCertificate...)
}

// readBufferedConnection 保留 CONNECT 请求后已被 net/http 预读的 TLS 字节。
type readBufferedConnection struct {
	net.Conn
	reader *bufio.Reader
}

// Read 优先消费 Hijack 返回的缓冲区，再继续读取底层连接。
func (connection *readBufferedConnection) Read(buffer []byte) (int, error) {
	return connection.reader.Read(buffer)
}

// singleConnectionListener 让标准库 HTTP Server 管理一个已完成握手的 TLS 连接。
type singleConnectionListener struct {
	connection net.Conn
	address    net.Addr
	accepted   bool
	done       chan struct{}
	closeOnce  sync.Once
	mu         sync.Mutex
}

// newSingleConnectionListener 创建一次性连接 Listener。
func newSingleConnectionListener(connection net.Conn) *singleConnectionListener {
	return &singleConnectionListener{
		connection: connection,
		address:    connection.LocalAddr(),
		done:       make(chan struct{}),
	}
}

// Accept 首次返回 TLS 连接，之后等待该连接关闭以结束 Serve。
func (listener *singleConnectionListener) Accept() (net.Conn, error) {
	listener.mu.Lock()
	if !listener.accepted {
		listener.accepted = true
		connection := &signalingConnection{Conn: listener.connection, done: listener.signalDone}
		listener.mu.Unlock()
		return connection, nil
	}
	done := listener.done
	listener.mu.Unlock()
	<-done
	return nil, net.ErrClosed
}

// Close 关闭唯一连接并解除 Accept 等待。
func (listener *singleConnectionListener) Close() error {
	listener.signalDone()
	return listener.connection.Close()
}

// Addr 返回 Unix Socket 外层连接对应的本地地址。
func (listener *singleConnectionListener) Addr() net.Addr {
	return listener.address
}

// signalDone 幂等通知内部 HTTP Server 连接生命周期已经结束。
func (listener *singleConnectionListener) signalDone() {
	listener.closeOnce.Do(func() { close(listener.done) })
}

// signalingConnection 在 HTTP Server 关闭连接时同步结束一次性 Listener。
type signalingConnection struct {
	net.Conn
	done func()
}

// Close 先通知 Listener，再关闭底层 TLS 连接。
func (connection *signalingConnection) Close() error {
	connection.done()
	return connection.Conn.Close()
}

// 确保一次性 Listener 满足标准库接口。
var _ net.Listener = (*singleConnectionListener)(nil)

// 确保缓冲连接仍完整满足 net.Conn。
var _ net.Conn = (*readBufferedConnection)(nil)
