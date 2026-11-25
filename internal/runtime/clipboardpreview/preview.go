// Package clipboardpreview renders bounded previews for file-reference clipboard
// items without loading arbitrary large binaries. Text and OOXML documents are
// extracted server-side; images and PDFs are streamed for the browser to render.
package clipboardpreview

import (
	"archive/zip"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	// MaxTextBytes bounds inline text returned by the preview API.
	MaxTextBytes = 64 * 1024
	// MaxFileBytes bounds the source file we are willing to inspect/stream.
	MaxFileBytes = 16 * 1024 * 1024
	// MaxArchiveEntryBytes bounds one OOXML part before extraction.
	MaxArchiveEntryBytes = 4 * 1024 * 1024
)

// Kind identifies the preview representation.
type Kind string

const (
	KindText  Kind = "text"
	KindImage Kind = "image"
	KindPDF   Kind = "pdf"
	KindNone  Kind = "none"
)

// Preview is the renderable form of one referenced file.
type Preview struct {
	Kind      Kind   `json:"kind"`
	MIME      string `json:"mime,omitempty"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Index     int    `json:"index"`
	FileName  string `json:"fileName,omitempty"`
}

var (
	tagPattern     = regexp.MustCompile(`(?s)<[^>]*>`)
	spacePattern   = regexp.MustCompile(`[ \t]+`)
	newlinePattern = regexp.MustCompile(`\n{3,}`)
)

// Describe picks the first usable file reference and returns its preview.
func Describe(files []string) Preview {
	for index, raw := range files {
		path := strings.TrimSpace(raw)
		if path == "" {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > MaxFileBytes {
			continue
		}
		ext := strings.ToLower(filepath.Ext(path))
		name := filepath.Base(path)
		switch {
		case imageMIME(ext) != "":
			return Preview{Kind: KindImage, MIME: imageMIME(ext), Index: index, FileName: name}
		case ext == ".pdf":
			return Preview{Kind: KindPDF, MIME: "application/pdf", Index: index, FileName: name}
		case ext == ".docx" || ext == ".xlsx" || ext == ".pptx":
			if text, ok := officeText(path, ext); ok && strings.TrimSpace(text) != "" {
				truncated := false
				if len(text) > MaxTextBytes {
					text = truncateUTF8(text, MaxTextBytes)
					truncated = true
				}
				return Preview{Kind: KindText, MIME: "text/plain; charset=utf-8", Text: text, Truncated: truncated, Index: index, FileName: name}
			}
			return Preview{Kind: KindNone, MIME: "application/octet-stream", Index: index, FileName: name}
		case textMIME(ext) != "":
			text, truncated, ok := readText(path)
			if !ok {
				return Preview{Kind: KindNone, MIME: "application/octet-stream", Index: index, FileName: name}
			}
			return Preview{Kind: KindText, MIME: "text/plain; charset=utf-8", Text: text, Truncated: truncated, Index: index, FileName: name}
		}
	}
	return Preview{Kind: KindNone}
}

// Streamable reports the file path, safe content type, and whether the file may
// be served inline. Only image/PDF/text references are exposed.
func Streamable(files []string, index int) (string, string, bool) {
	if index < 0 || index >= len(files) {
		return "", "", false
	}
	path := strings.TrimSpace(files[index])
	if path == "" {
		return "", "", false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > MaxFileBytes {
		return "", "", false
	}
	ext := strings.ToLower(filepath.Ext(path))
	if mime := imageMIME(ext); mime != "" {
		return path, mime, true
	}
	if ext == ".pdf" {
		return path, "application/pdf", true
	}
	if textMIME(ext) != "" {
		return path, "text/plain; charset=utf-8", true
	}
	return "", "", false
}

func imageMIME(ext string) string {
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

func textMIME(ext string) string {
	switch ext {
	case ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log",
		".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".htm", ".css",
		".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs",
		".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".sh", ".zsh",
		".bash", ".fish", ".sql", ".conf", ".env":
		return "text/plain; charset=utf-8"
	default:
		return ""
	}
}

func readText(path string) (string, bool, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false, false
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, MaxTextBytes+1))
	if err != nil {
		return "", false, false
	}
	truncated := len(raw) > MaxTextBytes
	if truncated {
		raw = raw[:MaxTextBytes]
	}
	if !utf8.Valid(raw) || strings.ContainsRune(string(raw), '\x00') {
		return "", false, false
	}
	return string(raw), truncated, true
}

func officeText(path, ext string) (string, bool) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return "", false
	}
	defer func() { _ = reader.Close() }()
	switch ext {
	case ".docx":
		return extractNamed(reader, "word/document.xml", []string{"</w:p>", "</w:tr>"})
	case ".xlsx":
		return extractNamed(reader, "xl/sharedStrings.xml", []string{"</si>"})
	case ".pptx":
		return extractSlides(reader)
	default:
		return "", false
	}
}

func extractNamed(reader *zip.ReadCloser, name string, breaks []string) (string, bool) {
	for _, file := range reader.File {
		if file.Name != name {
			continue
		}
		return xmlText(file, breaks), true
	}
	return "", false
}

func extractSlides(reader *zip.ReadCloser) (string, bool) {
	names := make([]string, 0, 32)
	for _, file := range reader.File {
		if strings.HasPrefix(file.Name, "ppt/slides/slide") && strings.HasSuffix(file.Name, ".xml") {
			names = append(names, file.Name)
		}
	}
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names)
	if len(names) > 30 {
		names = names[:30]
	}
	parts := make([]string, 0, len(names))
	for _, name := range names {
		for _, file := range reader.File {
			if file.Name == name {
				parts = append(parts, xmlText(file, []string{"</a:p>"}))
				break
			}
		}
	}
	return strings.Join(parts, "\n"), true
}

func xmlText(file *zip.File, breaks []string) string {
	stream, err := file.Open()
	if err != nil {
		return ""
	}
	defer func() { _ = stream.Close() }()
	raw, err := io.ReadAll(io.LimitReader(stream, MaxArchiveEntryBytes))
	if err != nil {
		return ""
	}
	text := string(raw)
	for _, token := range breaks {
		text = strings.ReplaceAll(text, token, "\n")
	}
	text = strings.ReplaceAll(text, "<w:tab/>", "\t")
	text = strings.ReplaceAll(text, "<w:br/>", "\n")
	text = strings.ReplaceAll(text, "<a:br/>", "\n")
	text = tagPattern.ReplaceAllString(text, "")
	text = html.UnescapeString(text)
	text = spacePattern.ReplaceAllString(text, " ")
	text = newlinePattern.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	cut := value[:maxBytes]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut
}
