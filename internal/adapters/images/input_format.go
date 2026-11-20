package images

// 输入侧的格式归一化。
//
// 设计对称性：客户端在入口可以提交任何网关能解码的图片格式（png / jpeg / webp），
// 但上游只接受它自己声明的格式。差异在编排层这里被吸收，Provider 策略永远只面对
// 它声明支持的字节——新增 Provider 只需要声明 InputFormats，不需要关心转码。

import (
	"bytes"
	"encoding/base64"
	"image"
	_ "image/gif" // 入口接受 gif，内部转码成上游格式
	"image/jpeg"
	"image/png"

	"github.com/HugoSmits86/nativewebp"
	"github.com/madou1217/ai_home/internal/adapters/imagedata"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// DefaultInputFormats 是 Provider 未声明输入格式时的接受集合。
//
// png / jpeg 是主流上游的最小公约数；webp 必须显式声明才接受原始字节。
var DefaultInputFormats = []Format{FormatPNG, FormatJPEG}

// AcceptedInputFormats 返回该策略上游可接受的参考图格式。
func AcceptedInputFormats(native Capabilities) []Format {
	if len(native.InputFormats) == 0 {
		return append([]Format(nil), DefaultInputFormats...)
	}
	formats := make([]Format, 0, len(native.InputFormats))
	for _, raw := range native.InputFormats {
		if format := normalizeFormat(raw); format != "" {
			formats = append(formats, format)
		}
	}
	if len(formats) == 0 {
		return append([]Format(nil), DefaultInputFormats...)
	}
	return formats
}

// NormalizeInputs 把参考图与蒙版转换成上游声明的格式。
//
// 已经符合声明的字节原样保留（只纠正被上游或客户端写错的 MIME）；不符合的转成声明的
// 首选格式。无法解码的输入返回 400，让客户端拿到明确原因而不是上游的模糊错误。
func NormalizeInputs(input Input, native Capabilities) (Input, error) {
	accepted := AcceptedInputFormats(native)
	if len(accepted) == 0 {
		return input, nil
	}
	target := preferredInputFormat(accepted)
	normalized := input
	normalized.Images = make([]imagegeneration.Image, len(input.Images))
	for i, source := range input.Images {
		converted, err := normalizeOneInput(source, accepted, target)
		if err != nil {
			return Input{}, err
		}
		normalized.Images[i] = converted
	}
	if input.Mask != nil {
		converted, err := normalizeOneInput(*input.Mask, accepted, target)
		if err != nil {
			return Input{}, err
		}
		normalized.Mask = &converted
	}
	return normalized, nil
}

// preferredInputFormat 选择转码目标：优先无损 png，其次声明里的第一个格式。
func preferredInputFormat(accepted []Format) Format {
	for _, format := range accepted {
		if format == FormatPNG {
			return FormatPNG
		}
	}
	return accepted[0]
}

// normalizeOneInput 归一化单张输入图。
func normalizeOneInput(source imagegeneration.Image, accepted []Format, target Format) (imagegeneration.Image, error) {
	payload, err := base64.StdEncoding.DecodeString(source.Data)
	if err != nil {
		return imagegeneration.Image{}, newError(400, "invalid_image_input", "image input is invalid base64")
	}
	config, actualFormat, err := image.DecodeConfig(bytes.NewReader(payload))
	if err != nil || config.Width <= 0 || config.Height <= 0 ||
		int64(config.Width)*int64(config.Height) > 32*1024*1024 {
		return imagegeneration.Image{}, newError(
			400,
			"unsupported_image_input_format",
			"image input must be png, jpeg or webp",
		)
	}
	actual := normalizeFormat(actualFormat)
	for _, format := range accepted {
		if format == actual {
			// 字节已符合上游声明：只把 MIME 对齐到真实格式。
			source.MIME = mimeForFormat(actual)
			return source, nil
		}
	}
	decoded, _, err := image.Decode(bytes.NewReader(payload))
	if err != nil {
		return imagegeneration.Image{}, newError(
			400,
			"unsupported_image_input_format",
			"image input cannot be decoded for conversion",
		)
	}
	encoded := boundedImageBuffer{remaining: nativeImageConversionBudget}
	switch target {
	case FormatPNG:
		err = png.Encode(&encoded, decoded)
	case FormatJPEG:
		err = jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 95})
	case FormatWebP:
		err = nativewebp.Encode(&encoded, decoded, nil)
	default:
		return imagegeneration.Image{}, newError(
			400,
			"unsupported_image_input_format",
			"image input cannot be converted to the provider's accepted formats",
		)
	}
	if err != nil {
		return imagegeneration.Image{}, newError(502, "invalid_image_input", "image input cannot be converted")
	}
	return imagegeneration.Image{
		MIME: mimeForFormat(target),
		Data: base64.StdEncoding.EncodeToString(encoded.buffer.Bytes()),
	}, nil
}

// mimeForFormat 把格式映射成 imagedata 的规范 MIME。
func mimeForFormat(format Format) imagedata.MIME {
	switch format {
	case FormatJPEG:
		return imagedata.MIMEJPEG
	case FormatWebP:
		return imagedata.MIMEWEBP
	default:
		return imagedata.MIMEPNG
	}
}
