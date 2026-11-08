// Package socks5 实现 relay 入口所需的最小 SOCKS5 服务端（RFC 1928 / RFC 1929）。
//
// 只负责握手、用户名/密码认证与 CONNECT 透传；UDP ASSOCIATE 仅完成关联登记，
// 真正的数据报中继由调用方通过 UDPAssociationRegistrar 注入（对应 S5 的 UDP 前端）。
// 首个字节为 0x05 的连接由 relaymux 分流进来，因此本包不自己监听端口。
package socks5

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// 协议常量（RFC 1928 握手/请求，RFC 1929 认证子协商）。
const (
	version = 0x05

	methodNoAuth       = 0x00
	methodUserPassword = 0x02
	methodNone         = 0xff

	authVersion = 0x01
	authOK      = 0x00
	authFailed  = 0x01

	commandConnect   = 0x01
	commandBind      = 0x02
	commandAssociate = 0x03

	replySucceeded           = 0x00
	replyGeneralFailure      = 0x01
	replyCommandNotSupported = 0x07
	replyAddressNotSupported = 0x08

	addressIPv4   = 0x01
	addressDomain = 0x03
	addressIPv6   = 0x04
)

const (
	defaultHandshakeTimeout = 5 * time.Second
	defaultDialTimeout      = 10 * time.Second
)

var (
	// ErrMissingAuthenticator 表示没有注入凭据校验回调，服务端会拒绝启动。
	ErrMissingAuthenticator = errors.New("socks5: 未配置凭据校验回调")
	// ErrVersion 表示对端不是 SOCKS5。
	ErrVersion = errors.New("socks5: 协议版本不匹配")
	// ErrAuthenticationMethod 表示客户端没有提供用户名/密码认证方法。
	ErrAuthenticationMethod = errors.New("socks5: 客户端未提供用户名/密码认证")
	// ErrAuthFailed 表示用户名或密码被回调拒绝。
	ErrAuthFailed = errors.New("socks5: 认证失败")
	// ErrCommandNotSupported 表示 CONNECT 之外、且未实现关联登记的命令（BIND 等）。
	ErrCommandNotSupported = errors.New("socks5: 不支持的命令")
	// ErrAddressTypeNotSupported 表示请求里的 ATYP 不在 RFC 1928 定义范围内。
	ErrAddressTypeNotSupported = errors.New("socks5: 不支持的地址类型")
)

// Authenticator 校验用户名/密码；clientAddr 是控制连接的来源地址。
//
// 密码比较请使用 EqualSecret：本包无法替回调实现常量时间语义。
type Authenticator func(username, password string, clientAddr net.Addr) bool

// DialContext 建立 CONNECT 的出口连接。username 是已认证的用户名，
// relay 用它选择节点出口（此时可忽略 address）；为 nil 时按请求目标直连。
// ctx 的超时来自 Config.DialTimeout。
type DialContext func(ctx context.Context, username, address string) (net.Conn, error)

// UDPAssociation 是一条 UDP ASSOCIATE 的登记信息。
type UDPAssociation struct {
	// ID 由服务端生成，Release 时原样回传。
	ID            string
	Username      string
	ClientAddr    net.Addr
	ServerAddr    net.Addr
	RequestedHost string
	RequestedPort int
	CreatedAt     time.Time
}

// UDPBinding 是登记成功后回复给客户端的 BND 地址。
type UDPBinding struct {
	// Address 为 nil 时用控制连接的本地地址（即实际 listener 地址）填写。
	Address net.Addr
}

// UDPAssociationRegistrar 接收 UDP ASSOCIATE 的关联登记。
//
// 本包只完成握手：Register 之后保持控制连接直到对端断开，再调用 Release。
// UDP 端口的绑定、客户端锁定与回程路由由实现方负责（S5）。
type UDPAssociationRegistrar interface {
	Register(association UDPAssociation) (UDPBinding, error)
	Release(id string)
}

// Config 是服务端配置。
type Config struct {
	Authenticate     Authenticator
	DialContext      DialContext
	UDP              UDPAssociationRegistrar
	HandshakeTimeout time.Duration
	DialTimeout      time.Duration
}

// Server 是可复用的 SOCKS5 服务端；每个 ServeConn 互不共享状态（除关联序号）。
type Server struct {
	config           Config
	dialContext      DialContext
	dialTimeout      time.Duration
	handshakeTimeout time.Duration
	associationSeq   atomic.Uint64
}

// New 创建服务端；缺少认证回调直接报错，避免误开免认证入口。
func New(config Config) (*Server, error) {
	if config.Authenticate == nil {
		return nil, ErrMissingAuthenticator
	}
	server := &Server{
		config:           config,
		dialContext:      config.DialContext,
		dialTimeout:      config.DialTimeout,
		handshakeTimeout: config.HandshakeTimeout,
	}
	if server.dialTimeout <= 0 {
		server.dialTimeout = defaultDialTimeout
	}
	if server.handshakeTimeout <= 0 {
		server.handshakeTimeout = defaultHandshakeTimeout
	}
	if server.dialContext == nil {
		dialer := &net.Dialer{Timeout: server.dialTimeout}
		server.dialContext = func(ctx context.Context, _ string, address string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", address)
		}
	}
	return server, nil
}

// Serve 接收 listener 上的连接，每条连接交给一个 goroutine；listener 关闭时返回。
func (server *Server) Serve(listener net.Listener) error {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return err
		}
		go func(conn net.Conn) {
			_ = server.ServeConn(conn)
		}(conn)
	}
}

// ServeConn 处理一条 SOCKS5 连接，返回时连接已关闭。
func (server *Server) ServeConn(conn net.Conn) error {
	if conn == nil {
		return net.ErrClosed
	}
	defer conn.Close()
	if server.handshakeTimeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(server.handshakeTimeout))
	}

	username, err := server.negotiate(conn)
	if err != nil {
		return err
	}
	request, err := readRequest(conn)
	if err != nil {
		if errors.Is(err, ErrAddressTypeNotSupported) {
			_ = writeReply(conn, replyAddressNotSupported, conn.LocalAddr())
		}
		return err
	}
	// 握手阶段结束，后续隧道/关联可以长时间存在。
	_ = conn.SetDeadline(time.Time{})

	switch request.command {
	case commandConnect:
		return server.handleConnect(conn, username, request)
	case commandAssociate:
		return server.handleAssociate(conn, username, request)
	default:
		// BIND 与未知命令统一回 0x07（RFC 1928 command not supported）。
		_ = writeReply(conn, replyCommandNotSupported, conn.LocalAddr())
		return ErrCommandNotSupported
	}
}

// negotiate 完成方法协商与 RFC 1929 用户名/密码认证。
//
// 只接受用户名/密码方法：relay 入口把用户名当作节点选择器，免认证方法一律拒绝。
func (server *Server) negotiate(conn net.Conn) (string, error) {
	var greeting [2]byte
	if _, err := io.ReadFull(conn, greeting[:]); err != nil {
		return "", err
	}
	if greeting[0] != version {
		return "", ErrVersion
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return "", err
	}
	if !containsMethod(methods, methodUserPassword) {
		_ = writeAll(conn, []byte{version, methodNone})
		return "", ErrAuthenticationMethod
	}
	if err := writeAll(conn, []byte{version, methodUserPassword}); err != nil {
		return "", err
	}

	var authHeader [2]byte
	if _, err := io.ReadFull(conn, authHeader[:]); err != nil {
		return "", err
	}
	if authHeader[0] != authVersion {
		return "", ErrAuthFailed
	}
	username := make([]byte, int(authHeader[1]))
	if _, err := io.ReadFull(conn, username); err != nil {
		return "", err
	}
	var passwordLength [1]byte
	if _, err := io.ReadFull(conn, passwordLength[:]); err != nil {
		return "", err
	}
	password := make([]byte, int(passwordLength[0]))
	if _, err := io.ReadFull(conn, password); err != nil {
		return "", err
	}
	if !server.config.Authenticate(string(username), string(password), conn.RemoteAddr()) {
		_ = writeAll(conn, []byte{authVersion, authFailed})
		return "", ErrAuthFailed
	}
	if err := writeAll(conn, []byte{authVersion, authOK}); err != nil {
		return "", err
	}
	return string(username), nil
}

// request 是解析后的 SOCKS5 请求（VER CMD RSV ATYP DST.ADDR DST.PORT）。
type request struct {
	command byte
	host    string
	port    int
}

// address 返回可用于 net.JoinHostPort 的目标地址。
func (req request) address() string {
	return net.JoinHostPort(req.host, strconv.Itoa(req.port))
}

// readRequest 逐字段读取请求。这里直接读 conn 而不做预读缓冲：
// 握手结束后可能紧跟应用数据，任何 readahead 都会把它们吞掉。
func readRequest(conn net.Conn) (request, error) {
	var head [4]byte
	if _, err := io.ReadFull(conn, head[:]); err != nil {
		return request{}, err
	}
	if head[0] != version {
		return request{}, ErrVersion
	}
	result := request{command: head[1]}
	switch head[3] {
	case addressIPv4:
		var raw [net.IPv4len]byte
		if _, err := io.ReadFull(conn, raw[:]); err != nil {
			return request{}, err
		}
		result.host = net.IP(raw[:]).String()
	case addressIPv6:
		var raw [net.IPv6len]byte
		if _, err := io.ReadFull(conn, raw[:]); err != nil {
			return request{}, err
		}
		result.host = net.IP(raw[:]).String()
	case addressDomain:
		var length [1]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return request{}, err
		}
		if length[0] == 0 {
			return request{}, ErrAddressTypeNotSupported
		}
		domain := make([]byte, int(length[0]))
		if _, err := io.ReadFull(conn, domain); err != nil {
			return request{}, err
		}
		result.host = string(domain)
	default:
		return request{}, ErrAddressTypeNotSupported
	}
	var port [2]byte
	if _, err := io.ReadFull(conn, port[:]); err != nil {
		return request{}, err
	}
	result.port = int(binary.BigEndian.Uint16(port[:]))
	return result, nil
}

// handleConnect 建立出口连接并双向透传；回复的 BND 用实际 listener 地址。
func (server *Server) handleConnect(conn net.Conn, username string, req request) error {
	ctx, cancel := context.WithTimeout(context.Background(), server.dialTimeout)
	defer cancel()
	target, err := server.dialContext(ctx, username, req.address())
	if err != nil {
		_ = writeReply(conn, replyGeneralFailure, conn.LocalAddr())
		return err
	}
	defer target.Close()
	if err := writeReply(conn, replySucceeded, conn.LocalAddr()); err != nil {
		return err
	}
	tunnel(conn, target)
	return nil
}

// handleAssociate 登记 UDP 关联并保持控制连接；数据报转发由注册方负责。
func (server *Server) handleAssociate(conn net.Conn, username string, req request) error {
	if server.config.UDP == nil {
		_ = writeReply(conn, replyCommandNotSupported, conn.LocalAddr())
		return ErrCommandNotSupported
	}
	association := UDPAssociation{
		ID:            fmt.Sprintf("assoc-%d", server.associationSeq.Add(1)),
		Username:      username,
		ClientAddr:    conn.RemoteAddr(),
		ServerAddr:    conn.LocalAddr(),
		RequestedHost: req.host,
		RequestedPort: req.port,
		CreatedAt:     time.Now(),
	}
	binding, err := server.config.UDP.Register(association)
	if err != nil {
		_ = writeReply(conn, replyGeneralFailure, conn.LocalAddr())
		return err
	}
	defer server.config.UDP.Release(association.ID)
	address := binding.Address
	if address == nil {
		address = conn.LocalAddr()
	}
	if err := writeReply(conn, replySucceeded, address); err != nil {
		return err
	}
	// RFC 1928：UDP 关联的生命周期等于这条 TCP 控制连接。
	_, _ = io.Copy(io.Discard, conn)
	return nil
}

// tunnel 双向复制并在一个方向结束时半关闭另一侧，避免把响应方向提前截断。
func tunnel(left, right net.Conn) {
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		_, _ = io.Copy(right, left)
		closeWrite(right)
	}()
	go func() {
		defer wait.Done()
		_, _ = io.Copy(left, right)
		closeWrite(left)
	}()
	wait.Wait()
}

// closeWrite 尽量只半关闭写方向；连接不支持时退化为完整关闭。
func closeWrite(conn net.Conn) {
	if closer, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = closer.CloseWrite()
		return
	}
	_ = conn.Close()
}

// writeReply 写 VER REP RSV ATYP BND.ADDR BND.PORT。
func writeReply(conn net.Conn, reply byte, address net.Addr) error {
	atyp, raw, port := encodeAddress(address)
	payload := make([]byte, 0, 4+len(raw)+2)
	payload = append(payload, version, reply, 0x00, atyp)
	payload = append(payload, raw...)
	payload = append(payload, byte(port>>8), byte(port))
	return writeAll(conn, payload)
}

// encodeAddress 把 listener 地址编码成 SOCKS5 地址字段；无法表达的地址回 0.0.0.0:0。
func encodeAddress(address net.Addr) (byte, []byte, uint16) {
	switch value := address.(type) {
	case *net.TCPAddr:
		if value != nil {
			return encodeIP(value.IP, value.Port)
		}
	case *net.UDPAddr:
		if value != nil {
			return encodeIP(value.IP, value.Port)
		}
	}
	return addressIPv4, []byte{0, 0, 0, 0}, 0
}

func encodeIP(ip net.IP, port int) (byte, []byte, uint16) {
	if port < 0 || port > 65535 {
		port = 0
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return addressIPv4, ipv4, uint16(port)
	}
	if ipv6 := ip.To16(); ipv6 != nil {
		return addressIPv6, ipv6, uint16(port)
	}
	return addressIPv4, []byte{0, 0, 0, 0}, uint16(port)
}

func containsMethod(methods []byte, method byte) bool {
	for _, value := range methods {
		if value == method {
			return true
		}
	}
	return false
}

func writeAll(conn net.Conn, payload []byte) error {
	for len(payload) > 0 {
		written, err := conn.Write(payload)
		if err != nil {
			return err
		}
		payload = payload[written:]
	}
	return nil
}

// EqualSecret 用常量时间比较两段凭据，避免逐字节短路泄漏前缀信息。
//
// 长度不同或任一为空时直接返回 false：SOCKS5 报文的 ULEN/PLEN 本就是明文的，
// 长度不构成额外泄漏，而空密码不应该被当作有效凭据。
func EqualSecret(supplied, expected string) bool {
	if supplied == "" || len(supplied) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1
}
