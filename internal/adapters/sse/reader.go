// Package sse 提供上游协议 Adapter 共用的有界 SSE 分帧器。
package sse

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
)

const (
	// MaxEventBytes 限制单个 SSE 事件累计 data 的内存占用。
	MaxEventBytes = 8 * 1024 * 1024
	// maxLineBytes 限制任意单行，避免非 data 字段绕过事件上限。
	maxLineBytes = MaxEventBytes + 1024
	// initialBufferBytes 覆盖普通增量事件且不预分配最大缓冲区。
	initialBufferBytes = 64 * 1024
)

var (
	// ErrInvalidSource 表示 Reader 没有可读取的来源。
	ErrInvalidSource = errors.New("SSE 数据源无效")
	// ErrInvalidEvent 表示单行或完整事件超过安全边界。
	ErrInvalidEvent = errors.New("SSE 事件无效")
)

// ReadError 保留底层传输错误身份，同时禁止其文本穿透协议层。
type ReadError struct {
	cause error
}

// Error 返回固定低敏说明。
func (*ReadError) Error() string {
	return "读取 SSE 数据失败"
}

// Unwrap 支持 context、net 和 io 错误的身份判断。
func (err *ReadError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.cause
}

// Cause 返回仅供上游失败分类器使用的底层错误。
func (err *ReadError) Cause() error {
	if err == nil {
		return nil
	}
	return err.cause
}

// Event 是完成网络分块重组后的单个 SSE 事件。
type Event struct {
	eventType string
	data      []byte
}

// Type 返回去除首尾空白后的 event 字段。
func (event Event) Type() string {
	return event.eventType
}

// Data 返回由当前 Event 独占的 data。
//
// 调用方只应读取该切片，不应修改或在敏感日志中输出其内容。
func (event Event) Data() []byte {
	return event.data
}

// Reader 按空行边界解析 SSE，不把底层 Read 边界当作事件边界。
type Reader struct {
	source    *bufio.Reader
	eventType string
	data      []byte
	hasData   bool
	finished  bool
}

// NewReader 创建共享有界 SSE Reader。
func NewReader(source io.Reader) (*Reader, error) {
	if source == nil {
		return nil, ErrInvalidSource
	}
	return &Reader{
		source: bufio.NewReaderSize(source, initialBufferBytes),
	}, nil
}

// Next 返回下一个完整事件；多行 data 使用换行符连接。
func (reader *Reader) Next() (Event, error) {
	if reader == nil || reader.source == nil {
		return Event{}, ErrInvalidSource
	}
	if reader.finished {
		return Event{}, io.EOF
	}
	for {
		line, readErr := reader.readLine()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return Event{}, readErr
		}
		if len(line) > 0 {
			if err := reader.applyLine(line); err != nil {
				return Event{}, err
			}
		} else if readErr == nil {
			if event, found := reader.takeEvent(); found {
				return event, nil
			}
		}
		if errors.Is(readErr, io.EOF) {
			reader.finished = true
			if event, found := reader.takeEvent(); found {
				return event, nil
			}
			return Event{}, io.EOF
		}
	}
}

// readLine 重组 bufio 的长行分片，并显式区分超限和传输失败。
func (reader *Reader) readLine() ([]byte, error) {
	var line []byte
	for {
		fragment, prefix, err := reader.source.ReadLine()
		if len(fragment) > maxLineBytes-len(line) {
			return nil, ErrInvalidEvent
		}
		line = append(line, fragment...)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return line, io.EOF
			}
			return nil, &ReadError{cause: err}
		}
		if !prefix {
			return line, nil
		}
	}
}

// applyLine 只解释 Adapter 所需的 event、data 和注释字段。
func (reader *Reader) applyLine(line []byte) error {
	if line[0] == ':' {
		return nil
	}
	field, value := splitField(line)
	switch field {
	case "event":
		reader.eventType = string(value)
	case "data":
		return reader.appendData(value)
	}
	return nil
}

// splitField 按规范只移除冒号后的一个可选空格。
func splitField(line []byte) (string, []byte) {
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
func (reader *Reader) appendData(value []byte) error {
	additional := len(value)
	if reader.hasData {
		additional++
	}
	if additional > MaxEventBytes-len(reader.data) {
		return ErrInvalidEvent
	}
	if reader.hasData {
		reader.data = append(reader.data, '\n')
	}
	reader.data = append(reader.data, value...)
	reader.hasData = true
	return nil
}

// takeEvent 转移当前 data 所有权并重置下一事件状态。
func (reader *Reader) takeEvent() (Event, bool) {
	if !reader.hasData {
		reader.eventType = ""
		reader.data = reader.data[:0]
		return Event{}, false
	}
	event := Event{
		eventType: strings.TrimSpace(reader.eventType),
		data:      reader.data,
	}
	reader.eventType = ""
	reader.data = nil
	reader.hasData = false
	return event, true
}
