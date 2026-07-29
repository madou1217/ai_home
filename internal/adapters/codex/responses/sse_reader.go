package responses

import (
	"bufio"
	"bytes"
	"io"
	"strings"
)

const (
	// maxSSEEventBytes 限制单个上游事件的内存占用。
	maxSSEEventBytes = 8 * 1024 * 1024
	// initialSSEBufferBytes 避免普通小事件预分配最大缓冲区。
	initialSSEBufferBytes = 64 * 1024
)

// sseEvent 是完成网络分块重组后的单个 SSE 事件。
type sseEvent struct {
	eventType string
	data      []byte
}

// sseReader 按 SSE 空行边界读取事件，不把网络 Read 边界当作事件边界。
type sseReader struct {
	scanner   *bufio.Scanner
	eventType string
	data      []byte
	hasData   bool
	finished  bool
}

// newSSEReader 创建具有固定单事件上限的 Reader。
func newSSEReader(source io.Reader) *sseReader {
	scanner := bufio.NewScanner(source)
	scanner.Buffer(
		make([]byte, initialSSEBufferBytes),
		maxSSEEventBytes+1,
	)
	return &sseReader{scanner: scanner}
}

// Next 返回下一个完整 SSE 事件；多行 data 使用换行符连接。
func (reader *sseReader) Next() (sseEvent, error) {
	if reader == nil || reader.scanner == nil {
		return sseEvent{}, ErrInvalidUpstreamResponse
	}
	if reader.finished {
		return sseEvent{}, io.EOF
	}
	for reader.scanner.Scan() {
		line := bytes.TrimSuffix(reader.scanner.Bytes(), []byte{'\r'})
		if len(line) == 0 {
			if event, found := reader.takeEvent(); found {
				return event, nil
			}
			continue
		}
		if line[0] == ':' {
			continue
		}
		field, value := splitSSEField(line)
		switch field {
		case "event":
			reader.eventType = string(value)
		case "data":
			if err := reader.appendData(value); err != nil {
				return sseEvent{}, err
			}
		}
	}
	reader.finished = true
	if err := reader.scanner.Err(); err != nil {
		return sseEvent{}, upstreamReadError{cause: err}
	}
	if event, found := reader.takeEvent(); found {
		return event, nil
	}
	return sseEvent{}, io.EOF
}

// splitSSEField 按规范只移除冒号后的一个可选空格。
func splitSSEField(line []byte) (string, []byte) {
	index := bytes.IndexByte(line, ':')
	if index < 0 {
		return string(line), nil
	}
	value := line[index+1:]
	if len(value) > 0 && value[0] == ' ' {
		value = value[1:]
	}
	return string(line[:index]), value
}

// appendData 在追加前检查完整事件大小，防止多行绕过上限。
func (reader *sseReader) appendData(value []byte) error {
	additional := len(value)
	if reader.hasData {
		additional++
	}
	if additional > maxSSEEventBytes-len(reader.data) {
		return ErrInvalidUpstreamResponse
	}
	if reader.hasData {
		reader.data = append(reader.data, '\n')
	}
	reader.data = append(reader.data, value...)
	reader.hasData = true
	return nil
}

// takeEvent 返回拥有独立 data 副本的事件并清空当前积累。
func (reader *sseReader) takeEvent() (sseEvent, bool) {
	if !reader.hasData {
		reader.eventType = ""
		reader.data = reader.data[:0]
		return sseEvent{}, false
	}
	event := sseEvent{
		eventType: strings.TrimSpace(reader.eventType),
		data:      append([]byte(nil), reader.data...),
	}
	reader.eventType = ""
	reader.data = reader.data[:0]
	reader.hasData = false
	return event, true
}
