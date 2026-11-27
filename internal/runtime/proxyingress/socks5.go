package proxyingress

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	socksVersion                 = 0x05
	socksAuthVersion             = 0x01
	socksMethodNoAuth            = 0x00
	socksMethodUserPassword      = 0x02
	socksMethodNoAcceptable      = 0xFF
	socksCommandConnect          = 0x01
	socksAddressIPv4             = 0x01
	socksAddressDomain           = 0x03
	socksAddressIPv6             = 0x04
	socksReplySuccess            = 0x00
	socksReplyGeneralFailure     = 0x01
	socksReplyNotAllowed         = 0x02
	socksReplyCommandUnsupported = 0x07
	socksReplyAddressUnsupported = 0x08
)

var (
	errInvalidSOCKS     = errors.New("proxyingress: invalid SOCKS5 handshake")
	errSOCKSNoMethod    = errors.New("proxyingress: client did not offer username/password")
	errSOCKSAuthFailed  = errors.New("proxyingress: SOCKS5 authentication failed")
	errSOCKSTarget      = errors.New("proxyingress: invalid SOCKS5 target")
	errUpstreamResponse = errors.New("proxyingress: invalid upstream proxy response")
	errHeaderTooLarge   = errors.New("proxyingress: upstream response header too large")
)

func (i *Ingress) serveSOCKSConn(connection net.Conn) {
	deadline := time.Now().Add(i.handshakeTimeout)
	_ = connection.SetDeadline(deadline)
	reader := bufio.NewReaderSize(connection, socksReadBufferSize)
	target, err := i.negotiateSOCKS(connection, reader)
	if err != nil {
		return
	}

	ctx, cancel := context.WithCancel(i.ctx)
	defer cancel()
	upstream, err := i.openStream(ctx)
	if err != nil {
		_ = writeSOCKSReply(connection, socksReplyGeneralFailure)
		return
	}
	defer upstream.Close()

	remaining := time.Until(deadline)
	if remaining <= 0 {
		_ = writeSOCKSReply(connection, socksReplyGeneralFailure)
		return
	}
	type upstreamResult struct {
		reader io.Reader
		err    error
	}
	results := make(chan upstreamResult, 1)
	go func() {
		upstreamReader, err := connectUpstream(upstream, target, i.currentAuthorization(), i.maxHeaderBytes)
		results <- upstreamResult{reader: upstreamReader, err: err}
	}()
	timer := time.NewTimer(remaining)
	defer timer.Stop()

	var upstreamReader io.Reader
	select {
	case result := <-results:
		if result.err != nil {
			_ = writeSOCKSReply(connection, replyForUpstreamError(result.err))
			return
		}
		upstreamReader = result.reader
	case <-timer.C:
		_ = upstream.Close()
		_ = writeSOCKSReply(connection, socksReplyGeneralFailure)
		return
	case <-ctx.Done():
		_ = writeSOCKSReply(connection, socksReplyGeneralFailure)
		return
	}
	if err = writeSOCKSReply(connection, socksReplySuccess); err != nil {
		return
	}
	_ = connection.SetDeadline(time.Time{})
	relay(connection, upstream, upstreamReader, reader)
}

func (i *Ingress) negotiateSOCKS(connection net.Conn, reader *bufio.Reader) (string, error) {
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(reader, greeting); err != nil {
		return "", err
	}
	if greeting[0] != socksVersion {
		return "", errInvalidSOCKS
	}
	methodCount := int(greeting[1])
	if methodCount == 0 {
		_ = writeAll(connection, []byte{socksVersion, socksMethodNoAcceptable})
		return "", errSOCKSNoMethod
	}
	methods := make([]byte, methodCount)
	if _, err := io.ReadFull(reader, methods); err != nil {
		return "", err
	}
	if i.allowAnonymous && bytes.Contains(methods, []byte{socksMethodNoAuth}) {
		if err := writeAll(connection, []byte{socksVersion, socksMethodNoAuth}); err != nil {
			return "", err
		}
		return readSOCKSTarget(connection, reader)
	}
	if !bytes.Contains(methods, []byte{socksMethodUserPassword}) {
		_ = writeAll(connection, []byte{socksVersion, socksMethodNoAcceptable})
		return "", errSOCKSNoMethod
	}
	if err := writeAll(connection, []byte{socksVersion, socksMethodUserPassword}); err != nil {
		return "", err
	}
	if err := i.authenticateSOCKS(connection, reader); err != nil {
		return "", err
	}
	return readSOCKSTarget(connection, reader)
}

func (i *Ingress) authenticateSOCKS(connection net.Conn, reader *bufio.Reader) error {
	head := make([]byte, 2)
	if _, err := io.ReadFull(reader, head); err != nil {
		return err
	}
	if head[0] != socksAuthVersion {
		return errInvalidSOCKS
	}
	usernameLength := int(head[1])
	if usernameLength == 0 {
		_ = writeAll(connection, []byte{socksAuthVersion, 0x01})
		return errSOCKSAuthFailed
	}
	username := make([]byte, usernameLength)
	if _, err := io.ReadFull(reader, username); err != nil {
		return err
	}
	if _, err := io.ReadFull(reader, head[:1]); err != nil {
		return err
	}
	passwordLength := int(head[0])
	if passwordLength == 0 {
		_ = writeAll(connection, []byte{socksAuthVersion, 0x01})
		return errSOCKSAuthFailed
	}
	password := make([]byte, passwordLength)
	if _, err := io.ReadFull(reader, password); err != nil {
		return err
	}
	userOK := constantTimeEqual(string(username), i.credentials.Username)
	passwordOK := constantTimeEqual(string(password), i.credentials.Password)
	if !userOK || !passwordOK {
		_ = writeAll(connection, []byte{socksAuthVersion, 0x01})
		return errSOCKSAuthFailed
	}
	return writeAll(connection, []byte{socksAuthVersion, 0x00})
}

func readSOCKSTarget(connection net.Conn, reader *bufio.Reader) (string, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(reader, head); err != nil {
		return "", err
	}
	if head[0] != socksVersion || head[2] != 0x00 {
		return "", errInvalidSOCKS
	}
	if head[1] != socksCommandConnect {
		_ = writeSOCKSReply(connection, socksReplyCommandUnsupported)
		return "", errSOCKSTarget
	}

	var host string
	switch head[3] {
	case socksAddressIPv4:
		address := make([]byte, net.IPv4len)
		if _, err := io.ReadFull(reader, address); err != nil {
			return "", err
		}
		host = net.IP(address).String()
	case socksAddressIPv6:
		address := make([]byte, net.IPv6len)
		if _, err := io.ReadFull(reader, address); err != nil {
			return "", err
		}
		host = net.IP(address).String()
	case socksAddressDomain:
		length := make([]byte, 1)
		if _, err := io.ReadFull(reader, length); err != nil {
			return "", err
		}
		nameLength := int(length[0])
		if nameLength == 0 {
			_ = writeSOCKSReply(connection, socksReplyAddressUnsupported)
			return "", errSOCKSTarget
		}
		name := make([]byte, nameLength)
		if _, err := io.ReadFull(reader, name); err != nil {
			return "", err
		}
		if !validSOCKS5Domain(name) {
			_ = writeSOCKSReply(connection, socksReplyAddressUnsupported)
			return "", errSOCKSTarget
		}
		host = string(name)
	default:
		_ = writeSOCKSReply(connection, socksReplyAddressUnsupported)
		return "", errSOCKSTarget
	}

	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(reader, portBytes); err != nil {
		return "", err
	}
	port := int(portBytes[0])<<8 | int(portBytes[1])
	if port == 0 {
		_ = writeSOCKSReply(connection, socksReplyGeneralFailure)
		return "", errSOCKSTarget
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

func validSOCKS5Domain(name []byte) bool {
	if len(name) == 0 || len(name) > 255 {
		return false
	}
	for _, character := range name {
		if character < 0x21 || character > 0x7E {
			return false
		}
		switch character {
		case ':', '/', '@', '\\':
			return false
		}
	}
	return true
}

func writeSOCKSReply(connection net.Conn, reply byte) error {
	return writeAll(connection, []byte{
		socksVersion, reply, 0x00,
		socksAddressIPv4, 0, 0, 0, 0,
		0, 0,
	})
}

// connectUpstream performs the authenticated CONNECT that gives the SOCKS5
// client a tunnel through the upstream lease proxy. It returns a reader that
// first drains any bytes the upstream sent immediately after its response.
func connectUpstream(stream io.ReadWriteCloser, target, authorization string, maxHeaderBytes int) (io.Reader, error) {
	request := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Host: target},
		Host:   target,
		Header: http.Header{"Proxy-Authorization": []string{authorization}},
	}
	if err := request.WriteProxy(stream); err != nil {
		return nil, err
	}
	reader := bufio.NewReaderSize(stream, upstreamReadBufferSize)
	status, err := readConnectStatus(reader, maxHeaderBytes)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, &upstreamStatusError{status: status}
	}
	return reader, nil
}

type upstreamStatusError struct {
	status int
}

func (err *upstreamStatusError) Error() string {
	return "proxyingress: upstream proxy returned status " + strconv.Itoa(err.status)
}

func replyForUpstreamError(err error) byte {
	var status *upstreamStatusError
	if errors.As(err, &status) {
		switch status.status {
		case http.StatusForbidden, http.StatusProxyAuthRequired:
			return socksReplyNotAllowed
		}
	}
	return socksReplyGeneralFailure
}

func readConnectStatus(reader *bufio.Reader, limit int) (int, error) {
	if limit <= 0 {
		limit = DefaultMaxHeaderBytes
	}
	remaining := limit
	line, err := readBoundedLine(reader, &remaining)
	if err != nil {
		return 0, err
	}
	protocol, rest, ok := strings.Cut(line, " ")
	if !ok || !strings.HasPrefix(protocol, "HTTP/") {
		return 0, errUpstreamResponse
	}
	codeText, _, _ := strings.Cut(strings.TrimLeft(rest, " "), " ")
	if len(codeText) != 3 {
		return 0, errUpstreamResponse
	}
	code, err := strconv.Atoi(codeText)
	if err != nil || code < 100 || code > 999 {
		return 0, errUpstreamResponse
	}
	for {
		headerLine, err := readBoundedLine(reader, &remaining)
		if err != nil {
			return 0, err
		}
		if headerLine == "" {
			return code, nil
		}
		if headerLine[0] == ' ' || headerLine[0] == '\t' {
			return 0, errUpstreamResponse
		}
	}
}

func readBoundedLine(reader *bufio.Reader, remaining *int) (string, error) {
	line, err := reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return "", errHeaderTooLarge
	}
	if err != nil {
		return "", err
	}
	*remaining -= len(line)
	if *remaining < 0 {
		return "", errHeaderTooLarge
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r"), nil
}
