// Package clientprotocol 定义客户端协议 Adapter 的共享注册和输出合同。
package clientprotocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// ErrInvalidRenderedEvent 表示 SSE 事件名或 JSON 数据不满足共享输出合同。
var ErrInvalidRenderedEvent = errors.New("客户端协议渲染事件无效")

// RenderedEvent 是 HTTP 传输层可直接写为 SSE 的不可变事件。
type RenderedEvent struct {
	name string
	data []byte
}

// NewRenderedEvent 校验并复制调用方仍可能持有的 JSON 数据。
func NewRenderedEvent(name string, data []byte) (RenderedEvent, error) {
	var compact bytes.Buffer
	if name == "" ||
		len(name) > 128 ||
		!isValidEventName(name) ||
		json.Compact(&compact, data) != nil {
		return RenderedEvent{}, ErrInvalidRenderedEvent
	}
	return RenderedEvent{
		name: name,
		data: compact.Bytes(),
	}, nil
}

// NewMarshaledEvent 接管 json.Marshal 新结果的所有权，避免热路径重复校验和复制。
//
// 调用方交出后不得继续修改 data；该函数只供协议 Adapter 使用。
func NewMarshaledEvent(name string, data []byte) (RenderedEvent, error) {
	if name == "" ||
		len(name) > 128 ||
		!isValidEventName(name) ||
		len(data) == 0 ||
		bytes.ContainsAny(data, "\r\n") {
		return RenderedEvent{}, ErrInvalidRenderedEvent
	}
	return RenderedEvent{name: name, data: data}, nil
}

// Name 返回 SSE event 字段。
func (event RenderedEvent) Name() string {
	return event.name
}

// Data 返回不能修改事件内部状态的 JSON 数据副本。
func (event RenderedEvent) Data() []byte {
	return append([]byte(nil), event.data...)
}

// WriteDataTo 把只读 JSON 直接写入传输层，不暴露内部字节切片。
func (event RenderedEvent) WriteDataTo(output io.Writer) error {
	if output == nil || len(event.data) == 0 {
		return ErrInvalidRenderedEvent
	}
	_, err := output.Write(event.data)
	return err
}

// isValidEventName 只允许可安全写入单行 SSE event 字段的 ASCII 字符。
func isValidEventName(name string) bool {
	for _, character := range name {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '_' ||
			character == '-' ||
			character == '.' {
			continue
		}
		return false
	}
	return true
}
