// Package kirorelay 实现 kiro（Amazon CodeWhisperer 流式 RPC）的推理通道。
package kirorelay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"strconv"
)

// AWS event-stream 帧格式（官方 spec）：
//
//	[4B total length][4B headers length][4B prelude CRC]
//	[headers…][payload][4B message CRC]
//	header = [1B name len][name][1B value type][value]
//
// 值类型：0=true 1=false 2=byte 3=short 4=int 5=long 6=byte[] 7=string 8=timestamp 9=uuid。
//
// 与 Node 的 kiro-event-stream.js 同语义，但用 io.Reader + ReadFull 实现，天然支持
// 「网络分块把一帧劈开」；CRC 校验在 Go 侧是**硬失败**（Node 只做长度检查），
// 帧错位时立刻报错，而不是把后续帧读花。
const (
	preludeBytes    = 12
	messageCRCBytes = 4
	minFrameBytes   = preludeBytes + messageCRCBytes
	// maxFrameBytes 与 Node 同值：8 MiB，避免坏长度字段触发无限等待。
	maxFrameBytes = 8 * 1024 * 1024
)

var (
	// ErrInvalidFrame 表示帧结构非法（长度、头长度、值类型）。
	ErrInvalidFrame = errors.New("kiro event stream 帧无效")
	// ErrFrameChecksum 表示 prelude 或 message CRC 不匹配。
	ErrFrameChecksum = errors.New("kiro event stream 校验失败")
	// ErrFrameTooLarge 表示帧长度超过上限。
	ErrFrameTooLarge = errors.New("kiro event stream 帧过大")
)

// Frame 是一帧解码结果。Headers 只保留字符串形态（事件类型、异常类型足够）。
type Frame struct {
	Headers map[string]string
	Payload []byte
}

// EventType 返回 :event-type 头（没有时为空）。
func (frame Frame) EventType() string { return frame.Headers[":event-type"] }

// MessageType 返回 :message-type 头（event / exception / error）。
func (frame Frame) MessageType() string { return frame.Headers[":message-type"] }

// Decoder 从流里按帧读取。
type Decoder struct {
	reader io.Reader
}

// NewDecoder 创建解码器。
func NewDecoder(reader io.Reader) *Decoder { return &Decoder{reader: reader} }

// Next 读取下一帧；流结束时返回 io.EOF。
func (decoder *Decoder) Next() (Frame, error) {
	if decoder == nil || decoder.reader == nil {
		return Frame{}, ErrInvalidFrame
	}
	prelude := make([]byte, preludeBytes)
	if _, err := io.ReadFull(decoder.reader, prelude); err != nil {
		return Frame{}, err
	}
	totalLength := int(binary.BigEndian.Uint32(prelude[0:4]))
	headersLength := int(binary.BigEndian.Uint32(prelude[4:8]))
	if totalLength < minFrameBytes || totalLength > maxFrameBytes {
		return Frame{}, ErrFrameTooLarge
	}
	if headersLength < 0 || headersLength > totalLength-minFrameBytes {
		return Frame{}, ErrInvalidFrame
	}
	if crc32.ChecksumIEEE(prelude[0:8]) != binary.BigEndian.Uint32(prelude[8:12]) {
		return Frame{}, ErrFrameChecksum
	}
	rest := make([]byte, totalLength-preludeBytes)
	if _, err := io.ReadFull(decoder.reader, rest); err != nil {
		return Frame{}, err
	}
	messageCRC := binary.BigEndian.Uint32(rest[len(rest)-messageCRCBytes:])
	// AWS spec：message CRC 覆盖「整帧去掉末尾 4 字节」，包含 prelude CRC 本身。
	message := make([]byte, 0, preludeBytes+len(rest)-messageCRCBytes)
	message = append(message, prelude...)
	message = append(message, rest[:len(rest)-messageCRCBytes]...)
	if crc32.ChecksumIEEE(message) != messageCRC {
		return Frame{}, ErrFrameChecksum
	}
	headers, err := parseHeaders(rest[:headersLength])
	if err != nil {
		return Frame{}, err
	}
	payload := rest[headersLength : len(rest)-messageCRCBytes]
	return Frame{Headers: headers, Payload: payload}, nil
}

func parseHeaders(raw []byte) (map[string]string, error) {
	headers := make(map[string]string)
	cursor := 0
	for cursor < len(raw) {
		if cursor+1 > len(raw) {
			return nil, ErrInvalidFrame
		}
		nameLength := int(raw[cursor])
		cursor++
		if nameLength == 0 || cursor+nameLength+1 > len(raw) {
			return nil, ErrInvalidFrame
		}
		name := string(raw[cursor : cursor+nameLength])
		cursor += nameLength
		valueType := raw[cursor]
		cursor++
		value, next, err := readHeaderValue(valueType, raw, cursor)
		if err != nil {
			return nil, err
		}
		cursor = next
		headers[name] = value
	}
	return headers, nil
}

func readHeaderValue(valueType byte, raw []byte, cursor int) (string, int, error) {
	remaining := len(raw) - cursor
	switch valueType {
	case 0:
		return "true", cursor, nil
	case 1:
		return "false", cursor, nil
	case 2:
		if remaining < 1 {
			return "", 0, ErrInvalidFrame
		}
		return strconv.Itoa(int(int8(raw[cursor]))), cursor + 1, nil
	case 3:
		if remaining < 2 {
			return "", 0, ErrInvalidFrame
		}
		return strconv.Itoa(int(int16(binary.BigEndian.Uint16(raw[cursor:])))), cursor + 2, nil
	case 4:
		if remaining < 4 {
			return "", 0, ErrInvalidFrame
		}
		return strconv.Itoa(int(int32(binary.BigEndian.Uint32(raw[cursor:])))), cursor + 4, nil
	case 5, 8:
		if remaining < 8 {
			return "", 0, ErrInvalidFrame
		}
		return strconv.FormatInt(int64(binary.BigEndian.Uint64(raw[cursor:])), 10), cursor + 8, nil
	case 6, 7:
		if remaining < 2 {
			return "", 0, ErrInvalidFrame
		}
		length := int(binary.BigEndian.Uint16(raw[cursor:]))
		if remaining < 2+length {
			return "", 0, ErrInvalidFrame
		}
		value := raw[cursor+2 : cursor+2+length]
		if valueType == 6 {
			return fmt.Sprintf("%x", value), cursor + 2 + length, nil
		}
		return string(value), cursor + 2 + length, nil
	case 9:
		if remaining < 16 {
			return "", 0, ErrInvalidFrame
		}
		return fmt.Sprintf("%x", raw[cursor:cursor+16]), cursor + 16, nil
	default:
		return "", 0, fmt.Errorf("%w: 未知 header 值类型 %d", ErrInvalidFrame, valueType)
	}
}
