package imagesapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// 本文件把 multipart/form-data 请求归一成与 JSON 入口相同的请求体，
// 对应 Node 的 image-generation-multipart.js。归一之后两条入口共用同一个解析器，
// 避免 multipart 路径长出第二套校验规则。

// multipartScalarFields 是需要从表单里读回的标量字段。
var multipartScalarFields = []string{
	"model",
	"provider",
	"prompt",
	"n",
	"size",
	"quality",
	"response_format",
	"background",
	"output_format",
	"output_compression",
	"moderation",
}

// multipartImageMIMEs 是 multipart 入口允许的图片类型。
var multipartImageMIMEs = map[imagedata.MIME]struct{}{
	imagedata.MIMEPNG:  {},
	imagedata.MIMEJPEG: {},
	imagedata.MIMEWEBP: {},
}

// IsMultipart 判断请求媒体类型是否为 multipart/form-data。
func IsMultipart(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == "multipart/form-data"
}

// normalizeMultipartBody 读取并归一 multipart 请求体。
//
// 返回的是与 JSON 入口完全同构的 JSON 字节，因此后续校验、能力闸门与上游整形
// 都只有一条路径。
func normalizeMultipartBody(
	request *http.Request,
	maxBodyBytes int64,
) ([]byte, *images.Error) {
	if request == nil || request.Body == nil {
		return nil, multipartError("invalid_multipart_body", "request body is missing")
	}
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return nil, multipartError(
			"invalid_multipart_content_type",
			"request content type must be multipart/form-data",
		)
	}
	boundary := parameters["boundary"]
	if boundary == "" {
		return nil, multipartError(
			"invalid_multipart_body",
			"request body is not valid multipart/form-data",
		)
	}
	reader := multipart.NewReader(
		io.LimitReader(request.Body, maxBodyBytes+1),
		boundary,
	)

	fields := map[string]string{}
	var imageURLs []string
	var maskURL string
	maskCount := 0
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, multipartError(
				"invalid_multipart_body",
				"request body is not valid multipart/form-data",
			)
		}
		name := part.FormName()
		filename := part.FileName()
		if isMultipartScalar(name) {
			if filename != "" {
				return nil, multipartError(
					"invalid_multipart_field",
					"multipart field "+name+" must be text",
				)
			}
			if _, duplicated := fields[name]; duplicated {
				return nil, multipartError(
					"duplicate_multipart_field",
					"multipart field "+name+" must appear at most once",
				)
			}
			value, err := io.ReadAll(io.LimitReader(part, maxBodyBytes+1))
			if err != nil {
				return nil, multipartError("invalid_multipart_body", "multipart field is not readable")
			}
			fields[name] = string(value)
			continue
		}
		switch name {
		case "image", "image[]":
			dataURL, err := partToDataURL(part, "image", maxBodyBytes)
			if err != nil {
				return nil, err
			}
			imageURLs = append(imageURLs, dataURL)
		case "mask", "mask[]":
			maskCount++
			if maskCount > 1 {
				return nil, multipartError(
					"multiple_mask_inputs_unsupported",
					"at most one image mask is supported",
				)
			}
			dataURL, err := partToDataURL(part, "mask", maxBodyBytes)
			if err != nil {
				return nil, err
			}
			maskURL = dataURL
		default:
			// 未知字段忽略：OpenAI 客户端会带上额外的可选字段。
		}
	}
	if len(imageURLs) > imagegeneration.MaxImageInputs {
		return nil, multipartError(
			"invalid_image_count",
			fmt.Sprintf(
				"image edits support at most %d input images",
				imagegeneration.MaxImageInputs,
			),
		)
	}

	document := map[string]any{}
	for _, field := range multipartScalarFields {
		if value, found := fields[field]; found && value != "" {
			document[field] = value
		}
	}
	if len(imageURLs) > 0 {
		document["images"] = imageURLs
	}
	if maskURL != "" {
		document["mask"] = maskURL
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, multipartError("invalid_multipart_body", "multipart body is not encodable")
	}
	return encoded, nil
}

// isMultipartScalar 判断字段名是否属于标量字段。
func isMultipartScalar(name string) bool {
	for _, field := range multipartScalarFields {
		if field == name {
			return true
		}
	}
	return false
}

// partToDataURL 把一个文件 part 转成 data URL，并校验媒体类型与字节一致。
func partToDataURL(
	part *multipart.Part,
	role string,
	maxBodyBytes int64,
) (string, *images.Error) {
	if part.FileName() == "" {
		code := "invalid_image_file"
		if role == "mask" {
			code = "invalid_image_mask"
		}
		return "", multipartError(code, role+" must be a multipart file")
	}
	bytes, err := io.ReadAll(io.LimitReader(part, maxBodyBytes+1))
	if err != nil || int64(len(bytes)) > maxBodyBytes {
		return "", multipartError("invalid_multipart_body", "multipart file is not readable")
	}
	detected := imagedata.DetectMIME(bytes)
	declared := imagedata.NormalizeMIME(part.Header.Get("Content-Type"))
	invalidMimeCode := "invalid_image_mime"
	if role == "mask" {
		invalidMimeCode = "invalid_image_mask_mime"
	}
	if _, allowed := multipartImageMIMEs[detected]; !allowed {
		return "", multipartError(
			invalidMimeCode,
			role+" must be a PNG, JPEG, or WebP image",
		)
	}
	declaredHeader := strings.TrimSpace(part.Header.Get("Content-Type"))
	if declaredHeader != "" && (declared == "" || declared != detected) {
		return "", multipartError(
			invalidMimeCode,
			role+" mime type does not match its bytes",
		)
	}
	if role == "mask" && detected != imagedata.MIMEPNG {
		return "", multipartError("invalid_image_mask_mime", "image masks must use image/png")
	}
	return "data:" + string(detected) + ";base64," +
		base64.StdEncoding.EncodeToString(bytes), nil
}

// multipartError 创建 400 级 multipart 解析错误。
func multipartError(code string, detail string) *images.Error {
	return &images.Error{StatusCode: 400, Code: code, Detail: detail}
}
