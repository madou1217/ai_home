// Package pluginruntime 是 Go 数据面到 Node Plugin Host 的本机 RPC 适配器。
//
// 线合同与 Node 端（lib/plugins/transport）一致，由 contracts/plugins/contract.json 生成常量：
// 12 字节头（4 字节元数据长度 + 8 字节 payload 长度，大端）+ JSON 元数据 + 二进制 payload。
// 这里只做传输：协议握手、调用、取消、上限；不拥有选号、凭据或任何业务策略。
package pluginruntime

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
)

const headerBytes = 12

type frame struct {
	message plugincontract.Message
	payload []byte
}

func encodeFrame(message plugincontract.Message, payload []byte) ([]byte, error) {
	if len(payload) > plugincontract.MaxPayloadBytes {
		return nil, &Error{Code: plugincontract.CodeRpcPayloadLimit, Message: fmt.Sprintf("payload %d bytes exceeds %d", len(payload), plugincontract.MaxPayloadBytes)}
	}
	metadata, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	if len(metadata) == 0 || len(metadata) > plugincontract.MaxMetadataBytes {
		return nil, &Error{Code: plugincontract.CodeRpcMetadataLimit, Message: fmt.Sprintf("metadata %d bytes exceeds %d", len(metadata), plugincontract.MaxMetadataBytes)}
	}
	out := make([]byte, headerBytes+len(metadata)+len(payload))
	binary.BigEndian.PutUint32(out[0:4], uint32(len(metadata)))
	binary.BigEndian.PutUint64(out[4:12], uint64(len(payload)))
	copy(out[headerBytes:], metadata)
	copy(out[headerBytes+len(metadata):], payload)
	return out, nil
}

// readFrame 先校验头部声明的长度再分配内存：超限的帧不会被读进来。
func readFrame(reader io.Reader) (frame, error) {
	var header [headerBytes]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return frame{}, err
	}
	metadataSize := binary.BigEndian.Uint32(header[0:4])
	payloadSize := binary.BigEndian.Uint64(header[4:12])
	if metadataSize == 0 || metadataSize > plugincontract.MaxMetadataBytes {
		return frame{}, &Error{Code: plugincontract.CodeRpcMetadataLimit, Message: "metadata size out of range"}
	}
	if payloadSize > plugincontract.MaxPayloadBytes {
		return frame{}, &Error{Code: plugincontract.CodeRpcPayloadLimit, Message: "payload size out of range"}
	}
	body := make([]byte, int(metadataSize)+int(payloadSize))
	if _, err := io.ReadFull(reader, body); err != nil {
		return frame{}, err
	}
	var message plugincontract.Message
	if err := json.Unmarshal(body[:metadataSize], &message); err != nil {
		return frame{}, &Error{Code: plugincontract.CodeRpcInvalid, Message: "metadata is not valid JSON"}
	}
	if message.Kind == "" || message.ID == "" || message.ProtocolVersion == 0 {
		return frame{}, &Error{Code: plugincontract.CodeRpcInvalid, Message: "message is missing kind, id or protocolVersion"}
	}
	return frame{message: message, payload: body[metadataSize:]}, nil
}
