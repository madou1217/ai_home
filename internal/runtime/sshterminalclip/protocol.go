// Package sshterminalclip 实现严格零客户端的终端剪贴板协议（OSC 52 / OSC 5522）
// 与 `aih ssh-clipboard probe` 诊断。
//
// 它不使用 SSH RemoteForward、clip-agent 或 OSC 5379 的客户端桥：所有数据都来自
// 当前终端本身。协议解析与 Node 实现共用同一套字段语义。
package sshterminalclip

import (
	"encoding/base64"
	"strings"
)

const (
	// OSC52Prefix 是 OSC 52 前缀。
	OSC52Prefix = "\x1b]52;"
	// OSC5522Prefix 是 OSC 5522 前缀。
	OSC5522Prefix = "\x1b]5522;"
	// StringTerminator 是 ST 终止符。
	StringTerminator = "\x1b\\"
	// BELTerminator 是 BEL 终止符。
	BELTerminator = "\x07"
	// TmuxPassthroughPrefix 是 tmux 透传前缀。
	TmuxPassthroughPrefix = "\x1bPtmux;"

	pasteEventsSupportQuery          = "\x1b[?5522$p"
	pasteEventsSupportResponsePrefix = "\x1b[?5522;"
	pasteEventsEnable                = "\x1b[?5522h"
	pasteEventsDisable               = "\x1b[?5522l"
	osc5522TargetsMime               = "."
	defaultResponseID                = "__default__"
	defaultMaxBufferedText           = 24 * 1024 * 1024
)

// OSC5522ImageMimeTypes 是 5522 图片读取支持的类型。
var OSC5522ImageMimeTypes = []string{
	"image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff",
}

// OSC5522TextImageMimeTypes 是文本承载图片的类型。
var OSC5522TextImageMimeTypes = []string{"text/html"}

var osc5522ReadMimeTypes = append(append([]string{}, OSC5522ImageMimeTypes...), OSC5522TextImageMimeTypes...)

func wrapForTmux(sequence string, passthrough bool) string {
	if !passthrough || sequence == "" {
		return sequence
	}
	return TmuxPassthroughPrefix + strings.ReplaceAll(sequence, "\x1b", "\x1b\x1b") + StringTerminator
}

// PasteEventsModeSequence 返回开启/关闭 5522 paste events 的序列。
func PasteEventsModeSequence(enabled, tmuxPassthrough bool) string {
	sequence := pasteEventsDisable
	if enabled {
		sequence = pasteEventsEnable
	}
	return wrapForTmux(sequence, tmuxPassthrough)
}

// PasteEventsSupportQuery 返回 5522 paste events 支持查询序列。
func PasteEventsSupportQuery(tmuxPassthrough bool) string {
	return wrapForTmux(pasteEventsSupportQuery, tmuxPassthrough)
}

func normalizeTerminalMimeType(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	switch text {
	case "":
		return ""
	case osc5522TargetsMime:
		return osc5522TargetsMime
	case "public.png", "png":
		return "image/png"
	case "public.jpeg", "public.jpg", "jpeg", "jpg", "image/jpg":
		return "image/jpeg"
	case "public.webp", "webp":
		return "image/webp"
	case "public.gif", "gif":
		return "image/gif"
	case "public.bmp", "bmp":
		return "image/bmp"
	case "public.tiff", "public.tif", "tiff", "tif", "image/tif":
		return "image/tiff"
	case "public.html", "html":
		return "text/html"
	case "utf8", "plain", "public.utf8-plain-text":
		return "text/plain"
	default:
		return text
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func normalizeMimeList(values []string) []string {
	source := values
	if len(source) == 0 {
		source = osc5522ReadMimeTypes
	}
	seen := map[string]bool{}
	result := make([]string, 0, len(source))
	for _, value := range source {
		normalized := normalizeTerminalMimeType(value)
		if !containsString(osc5522ReadMimeTypes, normalized) || seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	return result
}

func normalizeReadMimeType(value string) string {
	text := normalizeTerminalMimeType(value)
	if text == osc5522TargetsMime || containsString(OSC5522ImageMimeTypes, text) ||
		containsString(OSC5522TextImageMimeTypes, text) || text == "text/plain" {
		return text
	}
	return ""
}

func normalizeOsc52Selection(value string) string {
	var builder strings.Builder
	for _, char := range strings.TrimSpace(value) {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
		}
	}
	if builder.Len() == 0 {
		return "c"
	}
	return builder.String()
}

func normalizeBase64(value string) string {
	var builder strings.Builder
	for _, char := range value {
		switch {
		case char == ' ', char == '\t', char == '\n', char == '\r', char == '\f', char == '\v':
			continue
		case (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '+' || char == '/' || char == '=':
			builder.WriteRune(char)
		default:
			return ""
		}
	}
	result := builder.String()
	if result == "" || result == "?" {
		return ""
	}
	return result
}

func encodeUTF8Base64(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func sanitizeOsc5522ID(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') ||
			char == '.' || char == '_' || char == '+' || char == '-' {
			builder.WriteRune(char)
			if builder.Len() >= 80 {
				break
			}
		}
	}
	return builder.String()
}

// OSC52ReadQuery 返回 OSC 52 剪贴板读取查询。
func OSC52ReadQuery(selection string, tmuxPassthrough bool) string {
	return wrapForTmux(OSC52Prefix+normalizeOsc52Selection(selection)+";?"+BELTerminator, tmuxPassthrough)
}

// OSC5522ReadMimeQuery 返回指定 MIME 的 5522 读取查询。
func OSC5522ReadMimeQuery(mimeType, id, loc, password, passwordKey, name string, tmuxPassthrough bool) string {
	normalized := normalizeReadMimeType(mimeType)
	if normalized == "" {
		return ""
	}
	metadata := []string{"type=read"}
	if safeID := sanitizeOsc5522ID(id); safeID != "" {
		metadata = append(metadata, "id="+safeID)
	}
	if strings.ToLower(strings.TrimSpace(loc)) == "primary" {
		metadata = append(metadata, "loc=primary")
	}
	encodedMime := encodeUTF8Base64(normalized)
	metadata = append(metadata, "mime="+encodedMime)
	if token := normalizeBase64(password); token != "" {
		key := "pw"
		if strings.ToLower(strings.TrimSpace(passwordKey)) == "password" {
			key = "password"
		}
		metadata = append(metadata, key+"="+token)
	}
	if trimmedName := strings.TrimSpace(name); trimmedName != "" {
		metadata = append(metadata, "name="+encodeUTF8Base64(trimmedName))
	}
	return wrapForTmux(OSC5522Prefix+strings.Join(metadata, ":")+";"+encodedMime+StringTerminator, tmuxPassthrough)
}

// OSC5522ListMimeTypesQuery 返回终端可用 MIME 列表查询。
func OSC5522ListMimeTypesQuery(id, loc string, tmuxPassthrough bool) string {
	metadata := []string{"type=read"}
	if safeID := sanitizeOsc5522ID(id); safeID != "" {
		metadata = append(metadata, "id="+safeID)
	}
	if strings.ToLower(strings.TrimSpace(loc)) == "primary" {
		metadata = append(metadata, "loc=primary")
	}
	query := OSC5522Prefix + strings.Join(metadata, ":") + ";" + encodeUTF8Base64(osc5522TargetsMime) + StringTerminator
	return wrapForTmux(query, tmuxPassthrough)
}

// OSC5522ReadImageQuery 返回按一组 MIME 读取图片的查询。
func OSC5522ReadImageQuery(mimeTypes []string, id string, tmuxPassthrough bool) string {
	normalized := normalizeMimeList(mimeTypes)
	metadata := []string{"type=read"}
	if safeID := sanitizeOsc5522ID(id); safeID != "" {
		metadata = append(metadata, "id="+safeID)
	}
	query := OSC5522Prefix + strings.Join(metadata, ":") + ";" + encodeUTF8Base64(strings.Join(normalized, " ")) + StringTerminator
	return wrapForTmux(query, tmuxPassthrough)
}

func decodeOsc5522Mime(value string) string {
	encoded := normalizeBase64(value)
	if encoded == "" {
		return ""
	}
	buffer, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(buffer) > 128 {
		return ""
	}
	return normalizeTerminalMimeType(string(buffer))
}

func errorForOsc5522Status(status string) error {
	normalized := strings.ToLower(strings.TrimSpace(status))
	var builder strings.Builder
	for _, char := range normalized {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '_' {
			builder.WriteRune(char)
		} else {
			builder.WriteByte('_')
		}
	}
	name := builder.String()
	if name == "" {
		name = "failed"
	}
	return &ProtocolError{Code: "ssh_clip_terminal_clipboard_" + name}
}

// ProtocolError 是带稳定 code 的剪贴板协议错误。
type ProtocolError struct{ Code string }

func (e *ProtocolError) Error() string { return e.Code }
