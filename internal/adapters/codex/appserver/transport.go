package appserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"sync"
)

// maxLineBytes 是单行报文上限；thread/list 一页 100 条也远小于该值。
const maxLineBytes = 8 << 20

// rpcResult 是单个请求的终态：成功结果或错误，二者只有一个有效。
type rpcResult struct {
	result json.RawMessage
	err    error
}

// rpcConn 是 newline-delimited JSON 上的并发请求复用器。
//
// 写侧由 writeMu 串行化；读侧只有 readLoop 一个 goroutine，把响应按 ID 分派
// 给等待方。EOF、读取失败或写失败都会把已登记请求统一置为同一传输错误。
type rpcConn struct {
	writer io.WriteCloser

	writeMu sync.Mutex
	nextID  int64

	mu      sync.Mutex
	pending map[string]chan rpcResult
	failure error
}

func newRPCConn(writer io.WriteCloser, reader io.Reader) *rpcConn {
	connection := &rpcConn{
		writer:  writer,
		pending: make(map[string]chan rpcResult),
	}
	go connection.readLoop(reader)
	return connection
}

// request 发送一次请求并等待同 ID 的响应或 ctx 结束。
func (connection *rpcConn) request(
	ctx context.Context,
	method string,
	params any,
	result any,
) error {
	connection.mu.Lock()
	if connection.failure != nil {
		failure := connection.failure
		connection.mu.Unlock()
		return failure
	}
	connection.nextID++
	id := strconv.FormatInt(connection.nextID, 10)
	waiter := make(chan rpcResult, 1)
	connection.pending[id] = waiter
	connection.mu.Unlock()

	payload, err := json.Marshal(map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	})
	if err != nil {
		connection.forget(id)
		return fmt.Errorf("%w: 编码 %s 失败: %v", ErrProtocol, method, err)
	}
	if err := connection.writeLine(payload); err != nil {
		connection.forget(id)
		connection.fail(fmt.Errorf("%w: 写入 %s 失败: %v", ErrTransport, method, err))
		return fmt.Errorf("%w: %v", ErrTransport, err)
	}

	select {
	case <-ctx.Done():
		connection.forget(id)
		return fmt.Errorf("Codex app-server 请求 %s 未完成: %w", method, ctx.Err())
	case response := <-waiter:
		if response.err != nil {
			return response.err
		}
		if result == nil || len(response.result) == 0 {
			return nil
		}
		if err := json.Unmarshal(response.result, result); err != nil {
			return fmt.Errorf("%w: 解码 %s 结果失败: %v", ErrProtocol, method, err)
		}
		return nil
	}
}

// notify 发送一条没有 ID 的通知。
func (connection *rpcConn) notify(method string, params any) error {
	if err := connection.failureError(); err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"method": method,
		"params": params,
	})
	if err != nil {
		return fmt.Errorf("%w: 编码通知 %s 失败: %v", ErrProtocol, method, err)
	}
	if err := connection.writeLine(payload); err != nil {
		connection.fail(fmt.Errorf("%w: 写入通知 %s 失败: %v", ErrTransport, method, err))
		return fmt.Errorf("%w: %v", ErrTransport, err)
	}
	return nil
}

// fail 把连接标记为不可用，并同步唤醒所有等待中的请求。首个失败原因保留。
func (connection *rpcConn) fail(cause error) {
	connection.mu.Lock()
	if connection.failure == nil {
		connection.failure = cause
	}
	waiters := make([]chan rpcResult, 0, len(connection.pending))
	for id, waiter := range connection.pending {
		delete(connection.pending, id)
		waiters = append(waiters, waiter)
	}
	failure := connection.failure
	connection.mu.Unlock()

	for _, waiter := range waiters {
		waiter <- rpcResult{err: failure}
	}
}

func (connection *rpcConn) failureError() error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return connection.failure
}

func (connection *rpcConn) forget(id string) {
	connection.mu.Lock()
	delete(connection.pending, id)
	connection.mu.Unlock()
}

func (connection *rpcConn) writeLine(payload []byte) error {
	line := append(payload, '\n')
	connection.writeMu.Lock()
	defer connection.writeMu.Unlock()
	_, err := connection.writer.Write(line)
	return err
}

// readLoop 按行解析 stdout；无法解析的行直接忽略（app-server 可能夹带日志）。
func (connection *rpcConn) readLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var envelope rpcEnvelope
		if err := json.Unmarshal(line, &envelope); err != nil {
			continue
		}
		if envelope.Method != "" {
			connection.handleServerRequest(envelope)
			continue
		}
		connection.settle(envelope)
	}
	cause := scanner.Err()
	if cause == nil {
		cause = io.EOF
	}
	connection.fail(fmt.Errorf("%w: %v", ErrTransport, cause))
}

// handleServerRequest 只回 -32601：本切片不实现服务端反向请求（审批等）。
func (connection *rpcConn) handleServerRequest(envelope rpcEnvelope) {
	id := normalizeID(envelope.ID)
	if id == "" {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"id": envelope.ID,
		"error": map[string]any{
			"code":    codeMethodNotFound,
			"message": "aih app-server client 不支持服务端请求",
		},
	})
	if err != nil {
		return
	}
	_ = connection.writeLine(payload)
}

// settle 按 ID 把响应交给等待方；无人认领的响应忽略。
func (connection *rpcConn) settle(envelope rpcEnvelope) {
	id := normalizeID(envelope.ID)
	if id == "" {
		return
	}
	connection.mu.Lock()
	waiter := connection.pending[id]
	if waiter != nil {
		delete(connection.pending, id)
	}
	connection.mu.Unlock()
	if waiter == nil {
		return
	}
	if envelope.Error != nil {
		waiter <- rpcResult{err: envelope.Error}
		return
	}
	waiter <- rpcResult{result: envelope.Result}
}

// normalizeID 把数字与字符串 ID 归一成同一键；null 视为无 ID。
func normalizeID(raw json.RawMessage) string {
	value := bytes.TrimSpace(raw)
	if len(value) == 0 || bytes.Equal(value, []byte("null")) {
		return ""
	}
	if value[0] == '"' {
		var decoded string
		if err := json.Unmarshal(value, &decoded); err != nil {
			return ""
		}
		return decoded
	}
	return string(value)
}

// ensure err 变量在编译期只暴露一次，避免误删 errors 导入。
