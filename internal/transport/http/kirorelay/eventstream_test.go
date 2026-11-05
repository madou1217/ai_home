package kirorelay

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"testing"
	"testing/iotest"
)

func encodeFrame(t *testing.T, headers map[string]string, payload []byte) []byte {
	t.Helper()
	headerBytes := make([]byte, 0, len(headers)*16)
	for name, value := range headers {
		if len(name) > 255 || len(value) > 65535 {
			t.Fatal("header 过长")
		}
		headerBytes = append(headerBytes, byte(len(name)))
		headerBytes = append(headerBytes, name...)
		headerBytes = append(headerBytes, 7) // string
		var length [2]byte
		binary.BigEndian.PutUint16(length[:], uint16(len(value)))
		headerBytes = append(headerBytes, length[:]...)
		headerBytes = append(headerBytes, value...)
	}
	total := 12 + len(headerBytes) + len(payload) + 4
	frame := make([]byte, 12, total)
	binary.BigEndian.PutUint32(frame[0:4], uint32(total))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(headerBytes)))
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))
	frame = append(frame, headerBytes...)
	frame = append(frame, payload...)
	binary.BigEndian.PutUint32(frame[0:4], uint32(len(frame)+4))
	// total 变化会改变 prelude CRC，重算一次。
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))
	messageCRC := crc32.ChecksumIEEE(frame)
	var tail [4]byte
	binary.BigEndian.PutUint32(tail[:], messageCRC)
	return append(frame, tail[:]...)
}

func TestDecoderReadsFrames(t *testing.T) {
	first := encodeFrame(t, map[string]string{
		":message-type": "event",
		":event-type":   "initial-response",
	}, []byte(`{"conversationId":"c1"}`))
	second := encodeFrame(t, map[string]string{
		":message-type": "event",
		":event-type":   "assistantResponseEvent",
	}, []byte(`{"content":"hi"}`))
	decoder := NewDecoder(bytes.NewReader(append(first, second...)))

	frame, err := decoder.Next()
	if err != nil {
		t.Fatal(err)
	}
	if frame.EventType() != "initial-response" || string(frame.Payload) != `{"conversationId":"c1"}` {
		t.Fatalf("first frame = %#v", frame)
	}
	frame, err = decoder.Next()
	if err != nil {
		t.Fatal(err)
	}
	if frame.MessageType() != "event" || string(frame.Payload) != `{"content":"hi"}` {
		t.Fatalf("second frame = %#v", frame)
	}
	if _, err := decoder.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("流结束应返回 EOF: %v", err)
	}
}

// 网络分块会把一帧劈开：逐字节读也必须能解码。
func TestDecoderHandlesSplitReads(t *testing.T) {
	frame := encodeFrame(t, map[string]string{":event-type": "assistantResponseEvent"}, []byte(`{"content":"ok"}`))
	decoder := NewDecoder(iotest.OneByteReader(bytes.NewReader(frame)))
	got, err := decoder.Next()
	if err != nil {
		t.Fatal(err)
	}
	if string(got.Payload) != `{"content":"ok"}` {
		t.Fatalf("payload = %s", got.Payload)
	}
}

func TestDecoderRejectsCorruptChecksum(t *testing.T) {
	frame := encodeFrame(t, map[string]string{":event-type": "x"}, []byte("payload"))
	frame[len(frame)-1] ^= 0xff
	if _, err := NewDecoder(bytes.NewReader(frame)).Next(); !errors.Is(err, ErrFrameChecksum) {
		t.Fatalf("message CRC 被改必须失败: %v", err)
	}
	frame = encodeFrame(t, map[string]string{":event-type": "x"}, []byte("payload"))
	frame[9] ^= 0xff
	if _, err := NewDecoder(bytes.NewReader(frame)).Next(); !errors.Is(err, ErrFrameChecksum) {
		t.Fatalf("prelude CRC 被改必须失败: %v", err)
	}
}

func TestDecoderRejectsUnknownHeaderType(t *testing.T) {
	headers := []byte{1, 'x', 42, 0}
	payload := []byte("p")
	total := 12 + len(headers) + len(payload) + 4
	frame := make([]byte, 12, total)
	binary.BigEndian.PutUint32(frame[0:4], uint32(total))
	binary.BigEndian.PutUint32(frame[4:8], uint32(len(headers)))
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))
	frame = append(frame, headers...)
	frame = append(frame, payload...)
	binary.BigEndian.PutUint32(frame[0:4], uint32(len(frame)+4))
	binary.BigEndian.PutUint32(frame[8:12], crc32.ChecksumIEEE(frame[0:8]))
	var tail [4]byte
	binary.BigEndian.PutUint32(tail[:], crc32.ChecksumIEEE(frame))
	frame = append(frame, tail[:]...)
	if _, err := NewDecoder(bytes.NewReader(frame)).Next(); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("未知 header 值类型必须失败: %v", err)
	}
}
