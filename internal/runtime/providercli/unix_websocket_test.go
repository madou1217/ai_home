//go:build !windows

package providercli

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// TestUnixWebSocketHandshakeMaskPingAndFragment 验证 UDS 握手、客户端 mask、pong 和分片文本。
func TestUnixWebSocketHandshakeMaskPingAndFragment(t *testing.T) {
	runtimeDir, err := os.MkdirTemp("", "aih-ws-test-")
	if err != nil {
		t.Fatalf("MkdirTemp() error = %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(runtimeDir) })
	socketPath := filepath.Join(runtimeDir, "codex.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	defer listener.Close()

	serverErr := make(chan error, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			serverErr <- acceptErr
			return
		}
		defer connection.Close()
		reader := bufio.NewReader(connection)
		request, readErr := http.ReadRequest(reader)
		if readErr != nil {
			serverErr <- readErr
			return
		}
		if request.URL.Path != "/rpc" {
			serverErr <- errors.New("握手路径错误")
			return
		}
		key := request.Header.Get("Sec-WebSocket-Key")
		_, writeErr := io.WriteString(connection,
			"HTTP/1.1 101 Switching Protocols\r\n"+
				"Connection: Upgrade\r\n"+
				"Upgrade: websocket\r\n"+
				"Sec-WebSocket-Accept: "+webSocketAccept(key)+"\r\n\r\n",
		)
		if writeErr != nil {
			serverErr <- writeErr
			return
		}
		fin, opcode, masked, payload, frameErr := readTestFrame(reader)
		if frameErr != nil || !fin || opcode != 0x1 || !masked ||
			!slices.Equal(payload, makeTestPayload(130)) {
			serverErr <- errors.New("客户端文本帧错误")
			return
		}
		if frameErr = writeTestFrame(connection, true, 0x9, []byte("ping"), false); frameErr != nil {
			serverErr <- frameErr
			return
		}
		fin, opcode, masked, payload, frameErr = readTestFrame(reader)
		if frameErr != nil || !fin || opcode != 0xA || !masked || string(payload) != "ping" {
			serverErr <- errors.New("客户端 pong 帧错误")
			return
		}
		if frameErr = writeTestFrame(connection, false, 0x1, []byte("hello "), false); frameErr != nil {
			serverErr <- frameErr
			return
		}
		serverErr <- writeTestFrame(connection, true, 0x0, []byte("world"), false)
	}()

	socket, err := dialUnixWebSocket(t.Context(), socketPath, time.Second)
	if err != nil {
		t.Fatalf("dialUnixWebSocket() error = %v", err)
	}
	defer socket.Close()
	if err := socket.WriteText(makeTestPayload(130)); err != nil {
		t.Fatalf("WriteText() error = %v", err)
	}
	payload, err := socket.ReadText()
	if err != nil || string(payload) != "hello world" {
		t.Fatalf("ReadText() = %q, %v", payload, err)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("fake websocket server error = %v", err)
	}
}

// TestUnixWebSocketRejectsMaskedServerFrame 验证服务端违规 mask 失败关闭。
func TestUnixWebSocketRejectsMaskedServerFrame(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	socket := &unixWebSocket{connection: client, reader: bufio.NewReader(client)}
	go func() {
		_ = writeTestFrame(server, true, 0x1, []byte("invalid"), true)
	}()
	if _, err := socket.ReadText(); !errors.Is(err, ErrWebSocketProtocol) {
		t.Fatalf("ReadText(masked server frame) error = %v", err)
	}
}

func makeTestPayload(length int) []byte {
	result := make([]byte, length)
	for index := range result {
		result[index] = byte('a' + index%26)
	}
	return result
}

// readTestFrame 解码测试服务端收到的 RFC 6455 帧。
func readTestFrame(reader io.Reader) (bool, byte, bool, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return false, 0, false, nil, err
	}
	length := uint64(header[1] & 0x7f)
	if length == 126 {
		encoded := make([]byte, 2)
		if _, err := io.ReadFull(reader, encoded); err != nil {
			return false, 0, false, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(encoded))
	} else if length == 127 {
		encoded := make([]byte, 8)
		if _, err := io.ReadFull(reader, encoded); err != nil {
			return false, 0, false, nil, err
		}
		length = binary.BigEndian.Uint64(encoded)
	}
	masked := header[1]&0x80 != 0
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(reader, mask[:]); err != nil {
			return false, 0, false, nil, err
		}
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(reader, payload); err != nil {
		return false, 0, false, nil, err
	}
	if masked {
		for index := range payload {
			payload[index] ^= mask[index%4]
		}
	}
	return header[0]&0x80 != 0, header[0] & 0x0f, masked, payload, nil
}

// writeTestFrame 写入测试服务端帧；masked=true 仅用于协议负例。
func writeTestFrame(
	writer io.Writer,
	fin bool,
	opcode byte,
	payload []byte,
	masked bool,
) error {
	first := opcode
	if fin {
		first |= 0x80
	}
	second := byte(0)
	if masked {
		second |= 0x80
	}
	header := []byte{first, second}
	switch {
	case len(payload) <= 125:
		header[1] |= byte(len(payload))
	case len(payload) <= 65535:
		header[1] |= 126
		encoded := make([]byte, 2)
		binary.BigEndian.PutUint16(encoded, uint16(len(payload)))
		header = append(header, encoded...)
	default:
		header[1] |= 127
		encoded := make([]byte, 8)
		binary.BigEndian.PutUint64(encoded, uint64(len(payload)))
		header = append(header, encoded...)
	}
	content := append([]byte(nil), payload...)
	if masked {
		mask := [4]byte{1, 2, 3, 4}
		header = append(header, mask[:]...)
		for index := range content {
			content[index] ^= mask[index%4]
		}
	}
	frame := append(header, content...)
	_, err := writer.Write(frame)
	return err
}
