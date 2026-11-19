package images

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
)

// Native conversion budgets bound encoded allocations independently of decoded
// pixels. Passthrough and unmodified native outputs retain their own contracts.
const nativeImageConversionBudget = 20 * 1024 * 1024

var errNativeImageOutputTooLarge = errors.New("native image conversion exceeds its output budget")

type boundedImageBuffer struct {
	bytes.Buffer
	remaining int
}

func (b *boundedImageBuffer) Write(p []byte) (int, error) {
	if len(p) > b.remaining {
		return 0, errNativeImageOutputTooLarge
	}
	n, err := b.Buffer.Write(p)
	b.remaining -= n
	return n, err
}

// encodeNativeImageOutput fulfills the requested encoding locally when Code
// Assist cannot select it. Never relabel JPEG bytes as PNG or drop the request.
func encodeNativeImageOutput(result Result, format string) (Result, error) {
	if format == "" {
		return result, nil
	}
	if format != "png" && format != "jpeg" {
		return Result{}, newError(400, "unsupported_image_output_format", "native image output must be png or jpeg")
	}
	targetMIME := "image/" + format
	remaining := nativeImageConversionBudget
	// Account for unchanged parts up front so their position cannot bypass
	// the aggregate budget reserved for conversions.
	for _, output := range result.Images {
		if output.MIME == targetMIME {
			remaining -= base64.StdEncoding.DecodedLen(len(output.B64JSON))
		}
	}
	for i := range result.Images {
		output := &result.Images[i]
		if output.MIME == targetMIME {
			continue
		}
		payload, err := base64.StdEncoding.DecodeString(output.B64JSON)
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "native image output is invalid base64")
		}
		config, _, err := image.DecodeConfig(bytes.NewReader(payload))
		// Bound decoded allocation independently of the compressed response limit.
		if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 32*1024*1024 {
			return Result{}, newError(502, "invalid_image_output", "native image output cannot be safely decoded")
		}
		decoded, _, err := image.Decode(bytes.NewReader(payload))
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "native image output cannot be decoded")
		}
		if remaining <= 0 {
			return Result{}, newError(502, "image_output_too_large", errNativeImageOutputTooLarge.Error())
		}
		encoded := boundedImageBuffer{remaining: remaining}
		if format == "png" {
			err = png.Encode(&encoded, decoded)
		} else {
			err = jpeg.Encode(&encoded, decoded, &jpeg.Options{Quality: 95})
		}
		if errors.Is(err, errNativeImageOutputTooLarge) {
			return Result{}, newError(502, "image_output_too_large", err.Error())
		}
		if err != nil {
			return Result{}, newError(502, "invalid_image_output", "native image output cannot be encoded")
		}
		remaining -= encoded.Len()
		output.B64JSON = base64.StdEncoding.EncodeToString(encoded.Bytes())
		output.MIME = targetMIME
	}
	return result, nil
}
