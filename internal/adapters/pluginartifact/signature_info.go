package pluginartifact

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// SignatureInfo 是包内声明的签名信息，只读取元数据，不做验签。
// 用途：安装前先知道 keyId，才能把用户提供的公钥登记到正确的信任槽位。
type SignatureInfo struct {
	Status   string `json:"status"`
	KeyID    string `json:"keyId,omitempty"`
	SignedAt string `json:"signedAt,omitempty"`
}

// ReadSignatureInfo 读取 .aih-plugin 头部的签名声明。
// 未签名返回 status=unsigned；结构损坏返回 plugin_signature_invalid。
func ReadSignatureInfo(file string) (SignatureInfo, error) {
	handle, err := os.Open(file)
	if err != nil {
		return SignatureInfo{}, pluginerr.New(codePackageMissing, fmt.Sprintf("找不到插件包：%s", file))
	}
	defer func() { _ = handle.Close() }()
	stat, err := handle.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > plugincontract.MaxPackageBytes {
		return SignatureInfo{}, pluginerr.New(codePackageBytesLimit, "")
	}
	header := make([]byte, headerBytes)
	if _, err := io.ReadFull(handle, header); err != nil || string(header[:len(Magic)]) != Magic {
		return SignatureInfo{}, pluginerr.New(codePackageMagicInvalid, "不是 AIH 插件包")
	}
	metadataBytes := binary.BigEndian.Uint32(header[len(Magic):])
	if metadataBytes == 0 || int64(metadataBytes) > plugincontract.MaxPackageMetadataBytes {
		return SignatureInfo{}, pluginerr.New(codePackageMetadataLimit, "")
	}
	metadataBuffer := make([]byte, metadataBytes)
	if _, err := io.ReadFull(handle, metadataBuffer); err != nil {
		return SignatureInfo{}, pluginerr.New(codePackageTruncated, "")
	}
	var metadata map[string]any
	if err := json.Unmarshal(metadataBuffer, &metadata); err != nil {
		return SignatureInfo{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	raw, present := metadata["signature"]
	if !present || raw == nil {
		return SignatureInfo{Status: "unsigned"}, nil
	}
	signature, ok := raw.(map[string]any)
	if !ok {
		return SignatureInfo{}, pluginerr.New(codeSignatureInvalid, "签名结构不合法")
	}
	algorithm, _ := signature["algorithm"].(string)
	value, _ := signature["value"].(string)
	keyID, _ := signature["keyId"].(string)
	if strings.TrimSpace(algorithm) != "ed25519" || strings.TrimSpace(value) == "" || strings.TrimSpace(keyID) == "" {
		return SignatureInfo{}, pluginerr.New(codeSignatureInvalid, "签名结构不合法")
	}
	signedAt, _ := signature["signedAt"].(string)
	return SignatureInfo{Status: "signed", KeyID: keyID, SignedAt: signedAt}, nil
}
