// Package sshbridge 实现 `aih ssh` 的客户端图像粘贴桥。
//
// 客户端从本机剪贴板读取图片，编码为 OSC 5379 帧写入 SSH tty；远端 aih PTY
// 解出图片并落盘后把路径注入当前会话。Go 侧只负责客户端与线协议。
package sshbridge

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

// Image 是已校验的剪贴板图片。
type Image struct {
	ID       string
	Buffer   []byte
	MimeType string
	SHA256   string
	Bytes    int
}

var imageMimeByExtension = map[string]string{
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"webp": "image/webp",
	"gif":  "image/gif",
	"bmp":  "image/bmp",
	"tif":  "image/tiff",
	"tiff": "image/tiff",
}

// NormalizeMimeType 归一化图片 MIME；未知类型返回空串。
func NormalizeMimeType(value string) string {
	mime := strings.ToLower(strings.TrimSpace(value))
	if mime == "image/jpg" {
		return "image/jpeg"
	}
	if mime == "image/tif" {
		return "image/tiff"
	}
	if mime == "public.tiff" || mime == "public.tif" || mime == "tiff" || mime == "tif" {
		return "image/tiff"
	}
	for _, known := range imageMimeByExtension {
		if mime == known {
			return mime
		}
	}
	return ""
}

// DetectImageType 按文件签名判断图片类型。
func DetectImageType(buffer []byte) (extension, mimeType string, ok bool) {
	if len(buffer) < 4 {
		return "", "", false
	}
	if len(buffer) >= 8 && buffer[0] == 0x89 && buffer[1] == 0x50 && buffer[2] == 0x4e && buffer[3] == 0x47 &&
		buffer[4] == 0x0d && buffer[5] == 0x0a && buffer[6] == 0x1a && buffer[7] == 0x0a {
		return "png", "image/png", true
	}
	if buffer[0] == 0xff && buffer[1] == 0xd8 && buffer[2] == 0xff {
		return "jpg", "image/jpeg", true
	}
	if len(buffer) >= 12 && string(buffer[0:4]) == "RIFF" && string(buffer[8:12]) == "WEBP" {
		return "webp", "image/webp", true
	}
	if len(buffer) >= 6 && (string(buffer[0:6]) == "GIF87a" || string(buffer[0:6]) == "GIF89a") {
		return "gif", "image/gif", true
	}
	if buffer[0] == 0x42 && buffer[1] == 0x4d {
		return "bmp", "image/bmp", true
	}
	if (buffer[0] == 0x49 && buffer[1] == 0x49 && buffer[2] == 0x2a && buffer[3] == 0x00) ||
		(buffer[0] == 0x4d && buffer[1] == 0x4d && buffer[2] == 0x00 && buffer[3] == 0x2a) {
		return "tiff", "image/tiff", true
	}
	return "", "", false
}

// ValidateImage 校验大小/签名/声明 MIME，并返回摘要。
func ValidateImage(buffer []byte, declaredMime string, maxBytes int) (Image, error) {
	if len(buffer) == 0 {
		return Image{}, errors.New("ssh_clip_image_empty")
	}
	if maxBytes <= 0 {
		maxBytes = 16 * 1024 * 1024
	}
	if len(buffer) > maxBytes {
		return Image{}, errors.New("ssh_clip_image_too_large")
	}
	_, detectedMime, ok := DetectImageType(buffer)
	if !ok {
		return Image{}, errors.New("ssh_clip_image_unsupported")
	}
	if declared := NormalizeMimeType(declaredMime); declared != "" && declared != detectedMime {
		return Image{}, errors.New("ssh_clip_image_mime_mismatch")
	}
	sum := sha256.Sum256(buffer)
	return Image{Buffer: buffer, MimeType: detectedMime, SHA256: hex.EncodeToString(sum[:]), Bytes: len(buffer)}, nil
}

// ExtensionFromMimeType 返回落盘扩展名（不含点）。
func ExtensionFromMimeType(mimeType string) string {
	switch NormalizeMimeType(mimeType) {
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpg"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "image/bmp":
		return "bmp"
	case "image/tiff":
		return "tiff"
	default:
		return ""
	}
}
