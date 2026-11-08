package socks5

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testUser     = "n0123456789ab"
	testPassword = "relay-secret"
)

func testAuthenticator(username, password string, _ net.Addr) bool {
	return username == testUser && EqualSecret(password, testPassword)
}

// serveEcho 在已建好的 listener 上跑一个 echo 服务。
func serveEcho(t *testing.T, listener net.Listener) string {
	t.Helper()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}(conn)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String()
}

func startEchoServer(t *testing.T, address string) string {
	t.Helper()
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("监听 echo 服务 %s 失败: %v", address, err)
	}
	return serveEcho(t, listener)
}

func startSocksServerOn(t *testing.T, address string, config Config) (string, net.Addr) {
	t.Helper()
	if config.Authenticate == nil {
		config.Authenticate = testAuthenticator
	}
	server, err := New(config)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("监听 SOCKS5 服务 %s 失败: %v", address, err)
	}
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String(), listener.Addr()
}

func startSocksServer(t *testing.T, config Config) (string, net.Addr) {
	t.Helper()
	return startSocksServerOn(t, "127.0.0.1:0", config)
}

func dialClient(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("连接 SOCKS5 服务失败: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("设置客户端超时失败: %v", err)
	}
	return conn
}

func writeBytes(t *testing.T, conn net.Conn, payload []byte) {
	t.Helper()
	if _, err := conn.Write(payload); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
}

func readExactly(t *testing.T, conn net.Conn, size int) []byte {
	t.Helper()
	buffer := make([]byte, size)
	if _, err := io.ReadFull(conn, buffer); err != nil {
		t.Fatalf("读取 %d 字节失败: %v", size, err)
	}
	return buffer
}

func authenticate(t *testing.T, conn net.Conn, user, password string) {
	t.Helper()
	writeBytes(t, conn, []byte{version, 1, methodUserPassword})
	if reply := readExactly(t, conn, 2); !bytes.Equal(reply, []byte{version, methodUserPassword}) {
		t.Fatalf("方法协商回复 = %v, want [5 2]", reply)
	}
	payload := []byte{authVersion, byte(len(user))}
	payload = append(payload, user...)
	payload = append(payload, byte(len(password)))
	payload = append(payload, password...)
	writeBytes(t, conn, payload)
	if reply := readExactly(t, conn, 2); !bytes.Equal(reply, []byte{authVersion, authOK}) {
		t.Fatalf("认证回复 = %v, want [1 0]", reply)
	}
}

func connectRequestIPv4(address *net.TCPAddr) []byte {
	payload := []byte{version, commandConnect, 0x00, addressIPv4}
	payload = append(payload, address.IP.To4()...)
	payload = append(payload, byte(address.Port>>8), byte(address.Port))
	return payload
}

func connectRequestIPv6(address *net.TCPAddr) []byte {
	payload := []byte{version, commandConnect, 0x00, addressIPv6}
	payload = append(payload, address.IP.To16()...)
	payload = append(payload, byte(address.Port>>8), byte(address.Port))
	return payload
}

func connectRequestDomain(host string, port int) []byte {
	payload := []byte{version, commandConnect, 0x00, addressDomain, byte(len(host))}
	payload = append(payload, host...)
	payload = append(payload, byte(port>>8), byte(port))
	return payload
}

func associateRequest() []byte {
	return []byte{version, commandAssociate, 0x00, addressIPv4, 0, 0, 0, 0, 0, 0}
}

func readReply(t *testing.T, conn net.Conn) (reply byte, atyp byte, host string, port int) {
	t.Helper()
	head := readExactly(t, conn, 4)
	atyp = head[3]
	switch atyp {
	case addressIPv4:
		host = net.IP(readExactly(t, conn, net.IPv4len)).String()
	case addressIPv6:
		host = net.IP(readExactly(t, conn, net.IPv6len)).String()
	case addressDomain:
		length := readExactly(t, conn, 1)[0]
		host = string(readExactly(t, conn, int(length)))
	default:
		t.Fatalf("回复里的 ATYP = %#x 无法解析", atyp)
	}
	portBytes := readExactly(t, conn, 2)
	return head[1], atyp, host, int(binary.BigEndian.Uint16(portBytes))
}

func resolveTCP(t *testing.T, address string) *net.TCPAddr {
	t.Helper()
	resolved, err := net.ResolveTCPAddr("tcp", address)
	if err != nil {
		t.Fatalf("解析地址 %s 失败: %v", address, err)
	}
	return resolved
}

func splitHostPort(t *testing.T, address string) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatalf("拆分地址 %s 失败: %v", address, err)
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		t.Fatalf("解析端口 %s 失败: %v", portText, err)
	}
	return host, port
}

func TestEqualSecret(t *testing.T) {
	if !EqualSecret("relay-secret", "relay-secret") {
		t.Fatal("相同凭据应通过")
	}
	if EqualSecret("relay-secret", "relay-secret2") {
		t.Fatal("不同长度凭据不应通过")
	}
	if EqualSecret("relay-secret", "relay-Secret") {
		t.Fatal("内容不同不应通过")
	}
	if EqualSecret("", "") {
		t.Fatal("空密码不应通过")
	}
}

func TestNewRequiresAuthenticator(t *testing.T) {
	if _, err := New(Config{}); !errors.Is(err, ErrMissingAuthenticator) {
		t.Fatalf("New() error = %v, want ErrMissingAuthenticator", err)
	}
}

func TestServerRejectsNoAuthMethod(t *testing.T) {
	socksAddr, _ := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	writeBytes(t, conn, []byte{version, 1, methodNoAuth})
	if reply := readExactly(t, conn, 2); !bytes.Equal(reply, []byte{version, methodNone}) {
		t.Fatalf("方法协商回复 = %v, want [5 255]", reply)
	}
	var buffer [1]byte
	if _, err := conn.Read(buffer[:]); err == nil {
		t.Fatal("服务端应在拒绝认证方法后关闭连接")
	}
}

func TestServerRejectsWrongPassword(t *testing.T) {
	socksAddr, _ := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	writeBytes(t, conn, []byte{version, 1, methodUserPassword})
	_ = readExactly(t, conn, 2)

	payload := []byte{authVersion, byte(len(testUser))}
	payload = append(payload, testUser...)
	payload = append(payload, byte(len("wrong")))
	payload = append(payload, "wrong"...)
	writeBytes(t, conn, payload)
	if reply := readExactly(t, conn, 2); !bytes.Equal(reply, []byte{authVersion, authFailed}) {
		t.Fatalf("认证回复 = %v, want [1 1]", reply)
	}
	var buffer [1]byte
	if _, err := conn.Read(buffer[:]); err == nil {
		t.Fatal("服务端应在认证失败后关闭连接")
	}
}

func TestServerConnectsIPv4AndForwardsPipelinedBytes(t *testing.T) {
	echoAddr := startEchoServer(t, "127.0.0.1:0")
	socksAddr, socksListenerAddr := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)

	request := connectRequestIPv4(resolveTCP(t, echoAddr))
	// 请求与首个应用数据一次写入：验证握手读取没有预读、吞掉正文。
	writeBytes(t, conn, append(request, []byte("ping")...))

	reply, atyp, host, port := readReply(t, conn)
	if reply != replySucceeded {
		t.Fatalf("CONNECT 回复 = %#x, want 0", reply)
	}
	if atyp != addressIPv4 {
		t.Fatalf("BND ATYP = %#x, want IPv4", atyp)
	}
	wantHost, wantPort := splitHostPort(t, socksListenerAddr.String())
	if host != wantHost || port != wantPort {
		t.Fatalf("BND = %s:%d, want listener %s:%d", host, port, wantHost, wantPort)
	}
	if got := string(readExactly(t, conn, 4)); got != "ping" {
		t.Fatalf("echo = %q, want ping", got)
	}
}

func TestServerConnectsDomain(t *testing.T) {
	echoAddress := startEchoServer(t, "localhost:0")
	socksAddr, _ := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)

	echo := resolveTCP(t, echoAddress)
	writeBytes(t, conn, connectRequestDomain("localhost", echo.Port))
	reply, _, _, _ := readReply(t, conn)
	if reply != replySucceeded {
		t.Fatalf("CONNECT 域名回复 = %#x, want 0", reply)
	}
	writeBytes(t, conn, []byte("pong"))
	if got := string(readExactly(t, conn, 4)); got != "pong" {
		t.Fatalf("echo = %q, want pong", got)
	}
}

func TestServerConnectsIPv6(t *testing.T) {
	echoListener, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skipf("本机不支持 IPv6 回环: %v", err)
	}
	echoAddress := serveEcho(t, echoListener)
	socksAddr, socksListenerAddr := startSocksServerOn(t, "[::1]:0", Config{})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)

	writeBytes(t, conn, connectRequestIPv6(resolveTCP(t, echoAddress)))
	reply, atyp, host, port := readReply(t, conn)
	if reply != replySucceeded {
		t.Fatalf("CONNECT IPv6 回复 = %#x, want 0", reply)
	}
	if atyp != addressIPv6 {
		t.Fatalf("BND ATYP = %#x, want IPv6", atyp)
	}
	wantHost, wantPort := splitHostPort(t, socksListenerAddr.String())
	if host != wantHost || port != wantPort {
		t.Fatalf("BND = %s:%d, want listener %s:%d", host, port, wantHost, wantPort)
	}
	writeBytes(t, conn, []byte("v6"))
	if got := string(readExactly(t, conn, 2)); got != "v6" {
		t.Fatalf("echo = %q, want v6", got)
	}
}

func TestServerRejectsBind(t *testing.T) {
	socksAddr, _ := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)
	writeBytes(t, conn, []byte{version, commandBind, 0x00, addressIPv4, 0, 0, 0, 0, 0, 0})
	reply, _, _, _ := readReply(t, conn)
	if reply != replyCommandNotSupported {
		t.Fatalf("BIND 回复 = %#x, want 0x07", reply)
	}
}

func TestServerUDPAssociateWithoutRegistrar(t *testing.T) {
	socksAddr, _ := startSocksServer(t, Config{})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)
	writeBytes(t, conn, associateRequest())
	reply, _, _, _ := readReply(t, conn)
	if reply != replyCommandNotSupported {
		t.Fatalf("UDP ASSOCIATE 回复 = %#x, want 0x07", reply)
	}
}

type fakeRegistrar struct {
	mu          sync.Mutex
	assoc       []UDPAssociation
	released    []string
	binding     UDPBinding
	registerErr error
	registered  chan UDPAssociation
	releaseCh   chan string
}

func newFakeRegistrar() *fakeRegistrar {
	return &fakeRegistrar{
		registered: make(chan UDPAssociation, 1),
		releaseCh:  make(chan string, 1),
	}
}

func (registrar *fakeRegistrar) Register(association UDPAssociation) (UDPBinding, error) {
	registrar.mu.Lock()
	registrar.assoc = append(registrar.assoc, association)
	registrar.mu.Unlock()
	if registrar.registerErr != nil {
		return UDPBinding{}, registrar.registerErr
	}
	select {
	case registrar.registered <- association:
	default:
	}
	return registrar.binding, nil
}

func (registrar *fakeRegistrar) Release(id string) {
	registrar.mu.Lock()
	registrar.released = append(registrar.released, id)
	registrar.mu.Unlock()
	select {
	case registrar.releaseCh <- id:
	default:
	}
}

func TestServerUDPAssociateRegistersAndReleases(t *testing.T) {
	registrar := newFakeRegistrar()
	socksAddr, socksListenerAddr := startSocksServer(t, Config{UDP: registrar})
	conn := dialClient(t, socksAddr)
	clientAddr := conn.LocalAddr().String()
	authenticate(t, conn, testUser, testPassword)
	writeBytes(t, conn, associateRequest())

	reply, atyp, host, port := readReply(t, conn)
	if reply != replySucceeded {
		t.Fatalf("UDP ASSOCIATE 回复 = %#x, want 0", reply)
	}
	if atyp != addressIPv4 {
		t.Fatalf("BND ATYP = %#x, want IPv4", atyp)
	}
	wantHost, wantPort := splitHostPort(t, socksListenerAddr.String())
	if host != wantHost || port != wantPort {
		t.Fatalf("BND = %s:%d, want listener %s:%d", host, port, wantHost, wantPort)
	}

	var association UDPAssociation
	select {
	case association = <-registrar.registered:
	case <-time.After(2 * time.Second):
		t.Fatal("等待 UDP 关联登记超时")
	}
	if !strings.HasPrefix(association.ID, "assoc-") {
		t.Fatalf("关联 ID = %q, want assoc-N", association.ID)
	}
	if association.Username != testUser {
		t.Fatalf("关联用户名 = %q, want %q", association.Username, testUser)
	}
	if association.RequestedHost != "0.0.0.0" || association.RequestedPort != 0 {
		t.Fatalf("关联请求目标 = %s:%d, want 0.0.0.0:0", association.RequestedHost, association.RequestedPort)
	}
	if association.ClientAddr.String() != clientAddr {
		t.Fatalf("关联客户端 = %s, want %s", association.ClientAddr, clientAddr)
	}
	if association.ServerAddr.String() != socksAddr {
		t.Fatalf("关联服务端 = %s, want %s", association.ServerAddr, socksAddr)
	}

	_ = conn.Close()
	select {
	case released := <-registrar.releaseCh:
		if released != association.ID {
			t.Fatalf("Release(%q), want %q", released, association.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("控制连接关闭后未回收 UDP 关联")
	}
}

func TestServerUDPAssociateUsesRegistrarBinding(t *testing.T) {
	registrar := newFakeRegistrar()
	registrar.binding = UDPBinding{Address: &net.UDPAddr{IP: net.IPv4(192, 0, 2, 10), Port: 19527}}
	socksAddr, _ := startSocksServer(t, Config{UDP: registrar})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)
	writeBytes(t, conn, associateRequest())

	reply, _, host, port := readReply(t, conn)
	if reply != replySucceeded {
		t.Fatalf("UDP ASSOCIATE 回复 = %#x, want 0", reply)
	}
	if host != "192.0.2.10" || port != 19527 {
		t.Fatalf("BND = %s:%d, want 192.0.2.10:19527", host, port)
	}
}

func TestServerUDPAssociateRegisterFailure(t *testing.T) {
	registrar := newFakeRegistrar()
	registrar.registerErr = errors.New("udp 前端未启动")
	socksAddr, _ := startSocksServer(t, Config{UDP: registrar})
	conn := dialClient(t, socksAddr)
	authenticate(t, conn, testUser, testPassword)
	writeBytes(t, conn, associateRequest())
	reply, _, _, _ := readReply(t, conn)
	if reply != replyGeneralFailure {
		t.Fatalf("登记失败回复 = %#x, want 0x01", reply)
	}
}

func TestServerHandshakeTimeout(t *testing.T) {
	socksAddr, _ := startSocksServer(t, Config{HandshakeTimeout: 100 * time.Millisecond})
	conn := dialClient(t, socksAddr)
	var buffer [1]byte
	if _, err := conn.Read(buffer[:]); err == nil {
		t.Fatal("握手超时后服务端应关闭连接")
	}
}
