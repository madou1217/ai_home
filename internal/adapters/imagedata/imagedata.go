// Package imagedata 提供图片字节的媒体类型归一化、base64 规范化解码与魔数嗅探。
//
// 它对应 Node 的 lib/server/image-data.js，是图片生成请求解析的纯函数底座：
// 不读文件、不联网、不持有状态，因此可以在 HTTP 热路径上无锁复用。
package imagedata

import (
	"encoding/base64"
	"strings"
	"unicode"
)

// MIME 是受支持的图片媒体类型。
type MIME string

const (
	// MIMEPNG 表示 PNG。
	MIMEPNG MIME = "image/png"
	// MIMEJPEG 表示 JPEG。
	MIMEJPEG MIME = "image/jpeg"
	// MIMEWEBP 表示 WebP。
	MIMEWEBP MIME = "image/webp"
	// MIMEGIF 表示 GIF。
	MIMEGIF MIME = "image/gif"
)

// supportedMIMEs 与 Node 的 SUPPORTED_IMAGE_MIME_TYPES 一致。
var supportedMIMEs = map[MIME]struct{}{
	MIMEPNG:  {},
	MIMEJPEG: {},
	MIMEWEBP: {},
	MIMEGIF:  {},
}

// Decoded 是一次规范化 base64 解码的结果。
type Decoded struct {
	// Base64 是重新编码后的规范 base64（带标准填充）。
	Base64 string
	// Bytes 是解码后的原始字节。
	Bytes []byte
}

// NormalizeMIME 归一化媒体类型：丢弃参数段、转小写，并把 image/jpg 视作 image/jpeg。
//
// 不受支持或空值返回空串，与 Node 的 normalizeImageMime 一致。
func NormalizeMIME(value string) MIME {
	normalized := strings.ToLower(strings.TrimSpace(strings.SplitN(value, ";", 2)[0]))
	if normalized == "image/jpg" {
		return MIMEJPEG
	}
	candidate := MIME(normalized)
	if _, found := supportedMIMEs[candidate]; found {
		return candidate
	}
	return ""
}

// IsSupportedMIME 判断媒体类型是否属于可解码图片集合。
func IsSupportedMIME(mimeType MIME) bool {
	_, found := supportedMIMEs[mimeType]
	return found
}

// DecodeCanonicalBase64 解码 base64 并要求结果与规范编码逐字节一致。
//
// 该严格性是刻意保留的：Node 用同一套规则拒绝非规范 base64，放宽会让「同一张图
// 在不同客户端下算出不同指纹」的行为差异重新出现。
func DecodeCanonicalBase64(value string) (Decoded, bool) {
	compact := stripWhitespace(value)
	if compact == "" || len(compact)%4 == 1 || !isBase64Alphabet(compact) {
		return Decoded{}, false
	}
	unpadded := strings.TrimRight(compact, "=")
	if unpadded == "" {
		return Decoded{}, false
	}
	padding := (4 - len(unpadded)%4) % 4
	padded := unpadded + strings.Repeat("=", padding)
	bytes, err := base64.StdEncoding.DecodeString(padded)
	if err != nil || len(bytes) < 1 {
		return Decoded{}, false
	}
	canonical := base64.StdEncoding.EncodeToString(bytes)
	if strings.TrimRight(canonical, "=") != unpadded {
		return Decoded{}, false
	}
	return Decoded{Base64: canonical, Bytes: bytes}, true
}

// DetectMIME 按魔数嗅探图片类型，未识别返回空串。
func DetectMIME(bytes []byte) MIME {
	if len(bytes) >= 8 &&
		bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47 &&
		bytes[4] == 0x0d && bytes[5] == 0x0a && bytes[6] == 0x1a && bytes[7] == 0x0a {
		return MIMEPNG
	}
	if len(bytes) >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
		return MIMEJPEG
	}
	if len(bytes) >= 12 && string(bytes[0:4]) == "RIFF" && string(bytes[8:12]) == "WEBP" {
		return MIMEWEBP
	}
	if len(bytes) >= 6 &&
		bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == '8' &&
		(bytes[4] == '7' || bytes[4] == '9') && bytes[5] == 'a' {
		return MIMEGIF
	}
	return ""
}

// stripWhitespace 删除所有 Unicode 空白，与 Node 的 replace(/\s+/g, ”) 对齐。
func stripWhitespace(value string) string {
	if !strings.ContainsFunc(value, unicode.IsSpace) {
		return value
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for _, character := range value {
		if unicode.IsSpace(character) {
			continue
		}
		builder.WriteRune(character)
	}
	return builder.String()
}

// isBase64Alphabet 校验 ^[A-Za-z0-9+/]*={0,2}$：填充只允许出现在末尾且最多两个。
func isBase64Alphabet(value string) bool {
	padding := 0
	seenPadding := false
	for _, character := range value {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '+',
			character == '/':
			if seenPadding {
				return false
			}
		case character == '=':
			seenPadding = true
			padding++
			if padding > 2 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
