package relaycore

import (
	"bytes"
	"errors"
	"io"
	"strings"
)

// ssePeekChunkBytes 是预读时单次从上游读取的字节数。
const ssePeekChunkBytes = 8 * 1024

// errInvalidSSEPeek 表示调用参数不成立（reader 缺失或上限非正）。
var errInvalidSSEPeek = errors.New("relaycore: invalid sse peek")

// peekFirstSSEEvent 读取首个完整 SSE 事件，返回「已读的全部字节」与「事件内的 data」。
//
// 语义要点：
//   - 返回的 consumed 必须原样回放：里面可能包含事件边界之后的读前字节，
//     丢弃任何一个字节都会让下游 transformer 少一段内容。
//   - 事件边界按 SSE 规范是空行（\n\n 或 \r\n\r\n）；limit 只是防御，
//     首事件异常巨大时不再等待边界，直接以 truncated=true 返回，调用方据此放弃判定。
//   - 读到 EOF 也把已有字节交出去：短响应（非流式错误体）同样值得判定。
func peekFirstSSEEvent(reader io.Reader, limit int) (
	consumed []byte,
	event []byte,
	truncated bool,
	err error,
) {
	if reader == nil || limit <= 0 {
		return nil, nil, false, errInvalidSSEPeek
	}
	buffer := make([]byte, ssePeekChunkBytes)
	for len(consumed) <= limit {
		read, readErr := reader.Read(buffer)
		if read > 0 {
			consumed = append(consumed, buffer[:read]...)
			if end := sseEventEnd(consumed); end > 0 {
				return consumed, sseEventData(consumed[:end]), false, nil
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return consumed, sseEventData(consumed), false, nil
			}
			return consumed, sseEventData(consumed), false, readErr
		}
	}
	return consumed, sseEventData(consumed), true, nil
}

// sseEventEnd 返回首个事件（含结尾空行）的长度；没有完整事件时返回 0。
func sseEventEnd(payload []byte) int {
	if index := bytes.Index(payload, []byte("\n\n")); index >= 0 {
		return index + 2
	}
	if index := bytes.Index(payload, []byte("\r\n\r\n")); index >= 0 {
		return index + 4
	}
	return 0
}

// sseEventData 取出一个事件里的 data 载荷（多行按 \n 拼接）。
//
// 没有 data 字段时返回去掉首尾空白的原文：有些上游把 JSON 直接裸写在事件里，
// 判定方需要看到它，而不是空串。
func sseEventData(payload []byte) []byte {
	lines := strings.Split(strings.ReplaceAll(string(payload), "\r\n", "\n"), "\n")
	var data []byte
	hasData := false
	for _, line := range lines {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		value := line[len("data:"):]
		value = strings.TrimPrefix(value, " ")
		if hasData {
			data = append(data, '\n')
		}
		data = append(data, value...)
		hasData = true
	}
	if !hasData {
		return bytes.TrimSpace(payload)
	}
	return data
}
