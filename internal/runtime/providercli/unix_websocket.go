package providercli

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	webSocketGUID           = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	maxWebSocketMessageSize = 128 << 20
)

var ErrWebSocketProtocol = errors.New("Codex app-server WebSocket 协议错误")

// unixWebSocket 是 Codex UDS 控制通道所需的最小 RFC 6455 客户端。
//
// 它只支持文本消息、continuation、ping/pong 和 close，避免为一个本地私有通道
// 引入额外网络依赖；所有客户端数据帧均按协议使用随机 mask。
type unixWebSocket struct {
	connection net.Conn
	reader     *bufio.Reader
	writeMu    sync.Mutex
}

// dialUnixWebSocket 在 Unix Socket 上完成官方 Codex 使用的 /rpc WebSocket 握手。
func dialUnixWebSocket(
	ctx context.Context,
	socketPath string,
	timeout time.Duration,
) (*unixWebSocket, error) {
	dialer := &net.Dialer{Timeout: timeout}
	connection, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, err
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = connection.Close()
		}
	}()
	deadline := time.Now().Add(timeout)
	if err := connection.SetDeadline(deadline); err != nil {
		return nil, err
	}
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	request, err := http.NewRequest(http.MethodGet, "http://localhost/rpc", nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", key)
	if err := request.Write(connection); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusSwitchingProtocols ||
		!headerContainsToken(response.Header, "Connection", "upgrade") ||
		!headerContainsToken(response.Header, "Upgrade", "websocket") ||
		response.Header.Get("Sec-WebSocket-Accept") != webSocketAccept(key) {
		_ = response.Body.Close()
		return nil, fmt.Errorf("%w: 握手响应 %s", ErrWebSocketProtocol, response.Status)
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	succeeded = true
	return &unixWebSocket{connection: connection, reader: reader}, nil
}

// webSocketAccept 计算 RFC 6455 服务端握手摘要。
func webSocketAccept(key string) string {
	digest := sha1.Sum([]byte(key + webSocketGUID))
	return base64.StdEncoding.EncodeToString(digest[:])
}

// headerContainsToken 按逗号 token 和大小写无关规则匹配升级 Header。
func headerContainsToken(header http.Header, name string, expected string) bool {
	for _, value := range header.Values(name) {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), expected) {
				return true
			}
		}
	}
	return false
}

// WriteText 写入一个经过随机 mask 的完整文本帧。
func (socket *unixWebSocket) WriteText(payload []byte) error {
	return socket.writeFrame(0x1, payload)
}

// ReadText 读取一个完整文本消息，并在同一读循环内响应 ping。
func (socket *unixWebSocket) ReadText() ([]byte, error) {
	var message []byte
	expectingContinuation := false
	for {
		fin, opcode, payload, err := socket.readFrame()
		if err != nil {
			return nil, err
		}
		switch opcode {
		case 0x0:
			if !expectingContinuation {
				return nil, ErrWebSocketProtocol
			}
			message = append(message, payload...)
		case 0x1:
			if expectingContinuation {
				return nil, ErrWebSocketProtocol
			}
			message = append(message[:0], payload...)
			expectingContinuation = !fin
		case 0x2:
			return nil, fmt.Errorf("%w: 不支持二进制消息", ErrWebSocketProtocol)
		case 0x8:
			return nil, io.EOF
		case 0x9:
			if err := socket.writeFrame(0xA, payload); err != nil {
				return nil, err
			}
			continue
		case 0xA:
			continue
		default:
			return nil, ErrWebSocketProtocol
		}
		if len(message) > maxWebSocketMessageSize {
			return nil, fmt.Errorf("%w: 消息过大", ErrWebSocketProtocol)
		}
		if (opcode == 0x0 || opcode == 0x1) && fin {
			return message, nil
		}
	}
}

// readFrame 解码一个服务端帧并强制服务端不得使用 mask。
func (socket *unixWebSocket) readFrame() (bool, byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(socket.reader, header); err != nil {
		return false, 0, nil, err
	}
	fin := header[0]&0x80 != 0
	if header[0]&0x70 != 0 {
		return false, 0, nil, ErrWebSocketProtocol
	}
	opcode := header[0] & 0x0F
	masked := header[1]&0x80 != 0
	// RFC 6455 只允许客户端发往服务端的帧带 mask。
	if masked {
		return false, 0, nil, ErrWebSocketProtocol
	}
	length := uint64(header[1] & 0x7F)
	switch length {
	case 126:
		encoded := make([]byte, 2)
		if _, err := io.ReadFull(socket.reader, encoded); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(encoded))
	case 127:
		encoded := make([]byte, 8)
		if _, err := io.ReadFull(socket.reader, encoded); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(encoded)
		if length>>63 != 0 {
			return false, 0, nil, ErrWebSocketProtocol
		}
	}
	if length > maxWebSocketMessageSize || (opcode >= 0x8 && (!fin || length > 125)) {
		return false, 0, nil, ErrWebSocketProtocol
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(socket.reader, payload); err != nil {
		return false, 0, nil, err
	}
	return fin, opcode, payload, nil
}

// writeFrame 编码一个完整且随机 mask 的客户端帧，并处理短写。
func (socket *unixWebSocket) writeFrame(opcode byte, payload []byte) error {
	if socket == nil || socket.connection == nil || len(payload) > maxWebSocketMessageSize {
		return ErrWebSocketProtocol
	}
	socket.writeMu.Lock()
	defer socket.writeMu.Unlock()
	header := []byte{0x80 | opcode, 0x80}
	length := len(payload)
	switch {
	case length <= 125:
		header[1] |= byte(length)
	case length <= 65535:
		header[1] |= 126
		encoded := make([]byte, 2)
		binary.BigEndian.PutUint16(encoded, uint16(length))
		header = append(header, encoded...)
	default:
		header[1] |= 127
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, uint64(length))
		header = append(header, encoded...)
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	header = append(header, mask[:]...)
	masked := make([]byte, len(payload))
	for index := range payload {
		masked[index] = payload[index] ^ mask[index%len(mask)]
	}
	frame := append(header, masked...)
	for len(frame) > 0 {
		written, err := socket.connection.Write(frame)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrUnexpectedEOF
		}
		frame = frame[written:]
	}
	return nil
}

// Close 中断阻塞读取，并尽力发送正常关闭帧。
func (socket *unixWebSocket) Close() error {
	if socket == nil || socket.connection == nil {
		return nil
	}
	_ = socket.writeFrame(0x8, nil)
	return socket.connection.Close()
}
