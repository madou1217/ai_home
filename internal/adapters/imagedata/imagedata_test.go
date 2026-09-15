package imagedata_test

import (
	"encoding/base64"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
)

// TestNormalizeMIME 验证媒体类型归一化规则与 Node 一致。
func TestNormalizeMIME(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  imagedata.MIME
	}{
		{input: "image/png", want: imagedata.MIMEPNG},
		{input: "IMAGE/PNG", want: imagedata.MIMEPNG},
		{input: "image/png; charset=binary", want: imagedata.MIMEPNG},
		{input: " image/jpeg ", want: imagedata.MIMEJPEG},
		// Node 把 image/jpg 视作 image/jpeg。
		{input: "image/jpg", want: imagedata.MIMEJPEG},
		{input: "image/webp", want: imagedata.MIMEWEBP},
		{input: "image/gif", want: imagedata.MIMEGIF},
		{input: "image/bmp", want: ""},
		{input: "", want: ""},
		{input: "text/plain", want: ""},
	}

	for _, test := range tests {
		if got := imagedata.NormalizeMIME(test.input); got != test.want {
			t.Fatalf("NormalizeMIME(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

// TestDecodeCanonicalBase64AcceptsCanonicalInput 验证规范 base64 被接受。
func TestDecodeCanonicalBase64AcceptsCanonicalInput(t *testing.T) {
	t.Parallel()

	canonical := base64.StdEncoding.EncodeToString([]byte("image-bytes"))
	decoded, ok := imagedata.DecodeCanonicalBase64(canonical)
	if !ok {
		t.Fatalf("DecodeCanonicalBase64(%q) rejected canonical input", canonical)
	}
	if decoded.Base64 != canonical || string(decoded.Bytes) != "image-bytes" {
		t.Fatalf("decoded = %#v", decoded)
	}

	// 空白会被剥离，与 Node 的 replace(/\s+/g, '') 一致。
	withWhitespace := canonical[:4] + "\n  " + canonical[4:]
	if _, ok := imagedata.DecodeCanonicalBase64(withWhitespace); !ok {
		t.Fatal("whitespace should be stripped before decoding")
	}
}

// TestDecodeCanonicalBase64RejectsNonCanonicalInput 验证非规范输入被拒。
//
// 这组用例是刻意保留的严格性：Node 同样拒绝它们，放宽会改变图片指纹的稳定性。
func TestDecodeCanonicalBase64RejectsNonCanonicalInput(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
	}{
		{name: "empty", input: ""},
		{name: "whitespace only", input: "   "},
		{name: "length mod four is one", input: "AAAAA"},
		{name: "illegal character", input: "AA*A"},
		{name: "padding in the middle", input: "AA=A"},
		{name: "too much padding", input: "AAA==="},
		{name: "padding only", input: "=="},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if _, ok := imagedata.DecodeCanonicalBase64(test.input); ok {
				t.Fatalf("DecodeCanonicalBase64(%q) should have been rejected", test.input)
			}
		})
	}
}

// TestDecodeCanonicalBase64RejectsNonCanonicalPadding 验证多余填充位被拒。
//
// 标准解码器接受同一字节的多种尾部比特写法；Node 通过「重新编码后逐字节比对」
// 拒绝这些非规范形态，这里必须一致。
func TestDecodeCanonicalBase64RejectsNonCanonicalPadding(t *testing.T) {
	t.Parallel()

	// "ab" 的规范编码是 YWI=；YWJ= 解码出同样的字节但尾部比特非规范。
	if _, ok := imagedata.DecodeCanonicalBase64("YWJ="); ok {
		t.Fatal("non-canonical trailing bits should be rejected")
	}
	if _, ok := imagedata.DecodeCanonicalBase64("YWI="); !ok {
		t.Fatal("canonical encoding should be accepted")
	}
}

// TestDetectMIME 验证魔数嗅探。
func TestDetectMIME(t *testing.T) {
	t.Parallel()

	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	jpeg := []byte{0xff, 0xd8, 0xff}
	webp := append([]byte("RIFF"), append(make([]byte, 4), []byte("WEBP")...)...)
	gif := []byte("GIF89a")
	gif87 := []byte("GIF87a")

	tests := []struct {
		name  string
		bytes []byte
		want  imagedata.MIME
	}{
		{name: "png", bytes: png, want: imagedata.MIMEPNG},
		{name: "jpeg", bytes: jpeg, want: imagedata.MIMEJPEG},
		{name: "webp", bytes: webp, want: imagedata.MIMEWEBP},
		{name: "gif89a", bytes: gif, want: imagedata.MIMEGIF},
		{name: "gif87a", bytes: gif87, want: imagedata.MIMEGIF},
		{name: "unknown", bytes: []byte("not-an-image"), want: ""},
		{name: "empty", bytes: nil, want: ""},
		// 只有前三个字节的 JPEG 头也算 JPEG，与 Node 一致。
		{name: "truncated png", bytes: png[:4], want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := imagedata.DetectMIME(test.bytes); got != test.want {
				t.Fatalf("DetectMIME(%v) = %q, want %q", test.bytes, got, test.want)
			}
		})
	}
}
