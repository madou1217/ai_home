package images

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"strings"

	"github.com/HugoSmits86/nativewebp"
	_ "golang.org/x/image/webp" // 注册 WebP 解码器：转码源可以是 webp
)

// Native conversion budgets bound encoded allocations independently of decoded
// pixels. Passthrough and unmodified native outputs retain their own contracts.
const nativeImageConversionBudget = 20 * 1024 * 1024

var errNativeImageOutputTooLarge = errors.New("native image conversion exceeds its output budget")

type boundedImageBuffer struct {
	buffer    bytes.Buffer
	remaining int
}

func (b *boundedImageBuffer) Write(p []byte) (int, error) {
	if len(p) > b.remaining {
		return 0, errNativeImageOutputTooLarge
	}
	n, err := b.buffer.Write(p)
	b.remaining -= n
	return n, err
}

// TranscodeResult 把策略产出转成客户端请求的编码格式。
//
// 这是「不支持就转码」的唯一实现点：Provider 只声明原生格式，网关在这里用可解码的
// 原生结果重编码成请求格式（png / jpeg / webp）。任何 Provider 都不需要各自处理格式
// 差异，新增 Provider 也自动获得同一套转码能力。
//
// 只有在无法转码时才返回 400：请求格式未知，或上游结果不携带可解码的图片字节
// （例如透传策略直接返回了上游原始响应体，此时上游已经决定了格式）。
func TranscodeResult(result Result, requestedFormat string, native Capabilities) (Result, error) {
	// 空请求表示「不限格式」；非空但无法识别的格式必须显式拒绝，不能被当成没指定。
	if strings.TrimSpace(requestedFormat) == "" {
		return result, nil
	}
	target := normalizeFormat(requestedFormat)
	if target == "" {
		return Result{}, newError(400, "unsupported_image_output_format", "image output format must be png, jpeg or webp")
	}
	if target != FormatPNG && target != FormatJPEG && target != FormatWebP {
		return Result{}, newError(400, "unsupported_image_output_format", "image output format must be png, jpeg or webp")
	}
	// 透传策略的原始响应体由上游决定，网关不重写它。
	if len(result.PassthroughBody) > 0 || len(result.Images) == 0 {
		return result, nil
	}
	// 已满足目标格式时不动字节，避免无谓的有损重编码——但判断依据必须是**真实字节**，
	// 不能信任上游自报的 mimeType：实测 agy 会把 JPEG 标成 image/png。
	if allBytesAreFormat(result, target) {
		for i := range result.Images {
			result.Images[i].MIME = "image/" + string(target)
		}
		return result, nil
	}

	targetMIME := "image/" + string(target)
	remaining := nativeImageConversionBudget
	for i := range result.Images {
		output := &result.Images[i]
		payload, err := base64.StdEncoding.DecodeString(output.B64JSON)
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "image output is invalid base64")
		}
		config, actual, err := image.DecodeConfig(bytes.NewReader(payload))
		// Bound decoded allocation independently of the compressed response limit.
		if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 32*1024*1024 {
			return Result{}, newError(502, "invalid_image_output", "image output cannot be safely decoded")
		}
		// 真实字节已经是目标格式：只纠正被上游写错的 MIME，不重编码。
		if actual == string(target) {
			output.MIME = targetMIME
			remaining -= len(payload)
			continue
		}
		decoded, _, err := image.Decode(bytes.NewReader(payload))
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "image output cannot be decoded for transcoding")
		}
		if remaining <= 0 {
			return Result{}, newError(502, "image_output_too_large", errNativeImageOutputTooLarge.Error())
		}
		encoded := boundedImageBuffer{remaining: remaining}
		switch target {
		case FormatPNG:
			err = png.Encode(&encoded, decoded)
		case FormatJPEG:
			err = jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 95})
		case FormatWebP:
			err = nativewebp.Encode(&encoded, decoded, nil)
		}
		if errors.Is(err, errNativeImageOutputTooLarge) {
			return Result{}, newError(502, "image_output_too_large", err.Error())
		}
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "image output cannot be transcoded to "+string(target))
		}
		if encoded.buffer.Len() > remaining {
			return Result{}, newError(502, "image_output_too_large", errNativeImageOutputTooLarge.Error())
		}
		remaining -= encoded.buffer.Len()
		output.B64JSON = base64.StdEncoding.EncodeToString(encoded.buffer.Bytes())
		output.MIME = targetMIME
	}
	return result, nil
}

// allBytesAreFormat 用真实字节判断所有图片是否已经是目标格式。
//
// 只看解码器识别的格式，不看 MIME：上游的 mimeType 可能说谎（agy 用 JPEG 字节
// 报 image/png），信任标签会把 JPEG 当 PNG 交给客户端。
func allBytesAreFormat(result Result, format Format) bool {
	if len(result.Images) == 0 {
		return false
	}
	for _, output := range result.Images {
		payload, err := base64.StdEncoding.DecodeString(output.B64JSON)
		if err != nil {
			return false
		}
		_, actual, err := image.DecodeConfig(bytes.NewReader(payload))
		if err != nil || actual != string(format) {
			return false
		}
	}
	return true
}
