// Package clipboardio provides zero-cgo OS clipboard read/write primitives and capability detection.
package clipboardio

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	_ "golang.org/x/image/webp"

	"github.com/madou1217/ai_home/application/clipboard"
)

// ErrUnsupported indicates that the current host environment cannot access an OS clipboard.
var ErrUnsupported = errors.New("clipboard_io_unsupported")

// Capability reports whether OS clipboard access is available on this host.
type Capability struct {
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
}

// Snapshot is a single read of the OS clipboard.
type Snapshot struct {
	Kind   clipboard.Kind
	MIME   string
	Text   string
	Data   []byte
	Files  []string
	Width  int
	Height int
}

// Reader reads content from the OS clipboard.
type Reader interface {
	Probe() Capability
	ReadText(ctx context.Context, maxBytes int) (string, bool, error)
	ReadFiles(ctx context.Context) ([]string, bool, error)
	ReadImage(ctx context.Context, maxBytes int) (data []byte, mime string, ok bool, err error)
}

// Writer writes content to the OS clipboard.
type Writer interface {
	Probe() Capability
	WriteText(ctx context.Context, text string) error
	WriteImage(ctx context.Context, data []byte, mime string) error
	WriteFiles(ctx context.Context, files []string) error
}

// IO combines Reader and Writer for the local OS clipboard.
type IO interface {
	Reader
	Writer
}

// NewSystem returns the platform OS clipboard IO adapter.
func NewSystem() IO {
	return newSystemIO()
}

// DetectImageMIME inspects magic bytes to detect common image formats.
func DetectImageMIME(data []byte) (ext string, mime string, ok bool) {
	if len(data) < 4 {
		return "", "", false
	}
	if len(data) >= 8 &&
		data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47 &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a {
		return "png", "image/png", true
	}
	if data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
		return "jpg", "image/jpeg", true
	}
	if len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return "webp", "image/webp", true
	}
	if len(data) >= 6 && (string(data[0:6]) == "GIF87a" || string(data[0:6]) == "GIF89a") {
		return "gif", "image/gif", true
	}
	if data[0] == 0x42 && data[1] == 0x4d {
		return "bmp", "image/bmp", true
	}
	if (data[0] == 0x49 && data[1] == 0x49 && data[2] == 0x2a && data[3] == 0x00) ||
		(data[0] == 0x4d && data[1] == 0x4d && data[2] == 0x00 && data[3] == 0x2a) {
		return "tiff", "image/tiff", true
	}
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		return strings.TrimPrefix(detected, "image/"), detected, true
	}
	return "", "", false
}

// utf16LE encodes UTF-8 text into UTF-16LE bytes for PowerShell -EncodedCommand.
func utf16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	out := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		out = append(out, byte(unit), byte(unit>>8))
	}
	return out
}

func tempClipboardFile(ext string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "aih-clipboard-io-")
	if err != nil {
		return "", func() {}, err
	}
	name := "payload"
	if strings.TrimSpace(ext) != "" {
		name += "." + strings.TrimPrefix(strings.TrimSpace(ext), ".")
	}
	return filepath.Join(dir, name), func() { _ = os.RemoveAll(dir) }, nil
}

func ensurePNG(data []byte) ([]byte, error) {
	if _, mime, ok := DetectImageMIME(data); ok && mime == "image/png" {
		return data, nil
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func parseURIList(raw string) []string {
	lines := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		parsed, err := url.Parse(trimmed)
		if err != nil || !strings.EqualFold(parsed.Scheme, "file") {
			continue
		}
		path := parsed.Path
		if path == "" {
			continue
		}
		files = append(files, filepath.Clean(path))
	}
	return files
}

func formatURIList(files []string) string {
	var b strings.Builder
	for _, f := range files {
		abs, err := filepath.Abs(strings.TrimSpace(f))
		if err != nil || abs == "" {
			continue
		}
		u := url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
		b.WriteString(u.String())
		b.WriteString("\r\n")
	}
	return b.String()
}
