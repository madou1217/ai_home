// Package clipboardpreview renders bounded previews for file-reference clipboard
// items without loading arbitrary large binaries. Text and structured OOXML
// documents are extracted server-side; images, PDFs, and media are streamed for
// native renderers.
package clipboardpreview

import (
	"archive/zip"
	"encoding/xml"
	"html"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// MaxTextBytes bounds inline text returned by the preview API.
	MaxTextBytes = 64 * 1024
	// MaxFileBytes bounds document/image/PDF source files we inspect or stream.
	MaxFileBytes = 16 * 1024 * 1024
	// MaxMediaFileBytes bounds audio/video files streamed for native AV playback.
	MaxMediaFileBytes = 64 * 1024 * 1024
	// MaxArchiveEntryBytes bounds one OOXML part before extraction.
	MaxArchiveEntryBytes = 4 * 1024 * 1024

	maxOfficeBlocks = 400
	maxOfficeSheets = 12
	maxSheetRows    = 250
	maxSheetCols    = 40
	maxOfficeSlides = 30
)

// Kind identifies the preview representation.
type Kind string

const (
	KindText  Kind = "text"
	KindImage Kind = "image"
	KindPDF   Kind = "pdf"
	KindAudio Kind = "audio"
	KindVideo Kind = "video"
	KindNone  Kind = "none"
)

// OfficeBlock represents a structured DOCX block element (heading, paragraph, quote, or table).
type OfficeBlock struct {
	Kind string     `json:"kind"`
	Text string     `json:"text,omitempty"`
	Rows [][]string `json:"rows,omitempty"`
}

// DocumentPreview represents structured DOCX document content.
type DocumentPreview struct {
	Title  string        `json:"title,omitempty"`
	Blocks []OfficeBlock `json:"blocks"`
}

// SheetPreview represents one worksheet inside an XLSX workbook.
type SheetPreview struct {
	Name     string            `json:"name"`
	Rows     [][]string        `json:"rows"`
	Formulas map[string]string `json:"formulas,omitempty"`
}

// WorkbookPreview represents structured XLSX workbook content.
type WorkbookPreview struct {
	Sheets []SheetPreview `json:"sheets"`
}

// SlidePreview represents one slide inside a PPTX presentation.
type SlidePreview struct {
	Number int      `json:"number"`
	Title  string   `json:"title,omitempty"`
	Lines  []string `json:"lines"`
}

// PresentationPreview represents structured PPTX deck content.
type PresentationPreview struct {
	Slides []SlidePreview `json:"slides"`
}

// OfficePreview carries structured Office preview data alongside flat Text fallback.
type OfficePreview struct {
	Format       string               `json:"format"`
	Document     *DocumentPreview     `json:"document,omitempty"`
	Workbook     *WorkbookPreview     `json:"workbook,omitempty"`
	Presentation *PresentationPreview `json:"presentation,omitempty"`
}

// Preview is the renderable form of one referenced file.
type Preview struct {
	Kind      Kind           `json:"kind"`
	MIME      string         `json:"mime,omitempty"`
	Text      string         `json:"text,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`
	Index     int            `json:"index"`
	FileName  string         `json:"fileName,omitempty"`
	FileSize  int64          `json:"fileSize,omitempty"`
	Office    *OfficePreview `json:"office,omitempty"`
}

var (
	tagPattern     = regexp.MustCompile(`(?s)<[^>]*>`)
	spacePattern   = regexp.MustCompile(`[ \t]+`)
	newlinePattern = regexp.MustCompile(`\n{3,}`)
	cellRefPattern = regexp.MustCompile(`^([A-Z]+)(\d+)$`)
	slideNumRegex  = regexp.MustCompile(`slide(\d+)\.xml$`)
)

// Describe picks the first usable file reference and returns its preview.
func Describe(files []string) Preview {
	for index, raw := range files {
		if preview, ok := describeFile(raw, index); ok {
			return preview
		}
	}
	return Preview{Kind: KindNone}
}

// DescribeAt inspects a specific file index in a file list.
func DescribeAt(files []string, index int) Preview {
	if index < 0 || index >= len(files) {
		return Preview{Kind: KindNone, Index: index}
	}
	if preview, ok := describeFile(files[index], index); ok {
		return preview
	}
	filePath := strings.TrimSpace(files[index])
	name := ""
	var size int64
	if filePath != "" {
		name = filepath.Base(filePath)
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			size = info.Size()
		}
	}
	return Preview{Kind: KindNone, Index: index, FileName: name, FileSize: size}
}

func describeFile(raw string, index int) (Preview, bool) {
	filePath := strings.TrimSpace(raw)
	if filePath == "" {
		return Preview{}, false
	}
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() || info.Size() <= 0 {
		return Preview{}, false
	}
	ext := strings.ToLower(filepath.Ext(filePath))
	name := filepath.Base(filePath)
	size := info.Size()

	if mime := audioMIME(ext); mime != "" {
		if size > MaxMediaFileBytes {
			return Preview{}, false
		}
		return Preview{Kind: KindAudio, MIME: mime, Index: index, FileName: name, FileSize: size}, true
	}
	if mime := videoMIME(ext); mime != "" {
		if size > MaxMediaFileBytes {
			return Preview{}, false
		}
		return Preview{Kind: KindVideo, MIME: mime, Index: index, FileName: name, FileSize: size}, true
	}
	if size > MaxFileBytes {
		return Preview{}, false
	}
	switch {
	case imageMIME(ext) != "":
		return Preview{Kind: KindImage, MIME: imageMIME(ext), Index: index, FileName: name, FileSize: size}, true
	case ext == ".pdf":
		return Preview{Kind: KindPDF, MIME: "application/pdf", Index: index, FileName: name, FileSize: size}, true
	case ext == ".docx" || ext == ".xlsx" || ext == ".pptx":
		office, flatText, ok := extractOffice(filePath, ext)
		if ok && (office != nil || strings.TrimSpace(flatText) != "") {
			truncated := false
			if len(flatText) > MaxTextBytes {
				flatText = truncateUTF8(flatText, MaxTextBytes)
				truncated = true
			}
			return Preview{
				Kind:      KindText,
				MIME:      "text/plain; charset=utf-8",
				Text:      flatText,
				Truncated: truncated,
				Index:     index,
				FileName:  name,
				FileSize:  size,
				Office:    office,
			}, true
		}
		return Preview{Kind: KindNone, MIME: "application/octet-stream", Index: index, FileName: name, FileSize: size}, true
	case textMIME(ext) != "":
		text, truncated, ok := readText(filePath)
		if !ok {
			return Preview{Kind: KindNone, MIME: "application/octet-stream", Index: index, FileName: name, FileSize: size}, true
		}
		return Preview{Kind: KindText, MIME: "text/plain; charset=utf-8", Text: text, Truncated: truncated, Index: index, FileName: name, FileSize: size}, true
	default:
		return Preview{}, false
	}
}

// Streamable reports the file path, safe content type, and whether the file may
// be served inline. Only image/PDF/text/audio/video references are exposed.
func Streamable(files []string, index int) (string, string, bool) {
	filePath, mime, _, ok := StreamableBounded(files, index)
	return filePath, mime, ok
}

// StreamableBounded also returns the maximum allowed stream byte cap for the file type.
func StreamableBounded(files []string, index int) (string, string, int64, bool) {
	if index < 0 || index >= len(files) {
		return "", "", 0, false
	}
	filePath := strings.TrimSpace(files[index])
	if filePath == "" {
		return "", "", 0, false
	}
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() || info.Size() <= 0 {
		return "", "", 0, false
	}
	ext := strings.ToLower(filepath.Ext(filePath))
	if mime := audioMIME(ext); mime != "" {
		if info.Size() > MaxMediaFileBytes {
			return "", "", 0, false
		}
		return filePath, mime, MaxMediaFileBytes, true
	}
	if mime := videoMIME(ext); mime != "" {
		if info.Size() > MaxMediaFileBytes {
			return "", "", 0, false
		}
		return filePath, mime, MaxMediaFileBytes, true
	}
	if info.Size() > MaxFileBytes {
		return "", "", 0, false
	}
	if mime := imageMIME(ext); mime != "" {
		return filePath, mime, MaxFileBytes, true
	}
	if ext == ".pdf" {
		return filePath, "application/pdf", MaxFileBytes, true
	}
	if textMIME(ext) != "" {
		return filePath, "text/plain; charset=utf-8", MaxFileBytes, true
	}
	return "", "", 0, false
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
	case ".bmp":
		return "image/bmp"
	case ".tiff", ".tif":
		return "image/tiff"
	case ".heic":
		return "image/heic"
	default:
		return ""
	}
}

func audioMIME(ext string) string {
	switch ext {
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".m4a", ".aac":
		return "audio/mp4"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	case ".aiff", ".aif":
		return "audio/aiff"
	default:
		return ""
	}
}

func videoMIME(ext string) string {
	switch ext {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	default:
		return ""
	}
}

func textMIME(ext string) string {
	switch ext {
	case ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".log",
		".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".htm", ".css",
		".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs",
		".java", ".kt", ".swift", ".php", ".rb", ".cs", ".c", ".h", ".cc", ".cpp",
		".hpp", ".sh", ".zsh", ".bash", ".fish", ".sql", ".conf", ".env":
		return "text/plain; charset=utf-8"
	default:
		return ""
	}
}

func readText(filePath string) (string, bool, bool) {
	file, err := os.Open(filePath)
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

func extractOffice(filePath, ext string) (*OfficePreview, string, bool) {
	reader, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, "", false
	}
	defer func() { _ = reader.Close() }()
	filesByName := make(map[string]*zip.File, len(reader.File))
	for _, f := range reader.File {
		filesByName[f.Name] = f
	}
	switch ext {
	case ".docx":
		doc, flat := parseDocx(filesByName)
		if doc == nil && flat == "" {
			return nil, "", false
		}
		return &OfficePreview{Format: "docx", Document: doc}, flat, true
	case ".xlsx":
		wb, flat := parseXlsx(filesByName)
		if wb == nil && flat == "" {
			return nil, "", false
		}
		return &OfficePreview{Format: "xlsx", Workbook: wb}, flat, true
	case ".pptx":
		pres, flat := parsePptx(filesByName)
		if pres == nil && flat == "" {
			return nil, "", false
		}
		return &OfficePreview{Format: "pptx", Presentation: pres}, flat, true
	default:
		return nil, "", false
	}
}

func readZipEntry(file *zip.File) ([]byte, bool) {
	if file == nil {
		return nil, false
	}
	stream, err := file.Open()
	if err != nil {
		return nil, false
	}
	defer func() { _ = stream.Close() }()
	raw, err := io.ReadAll(io.LimitReader(stream, MaxArchiveEntryBytes))
	if err != nil {
		return nil, false
	}
	return raw, true
}

func parseDocx(files map[string]*zip.File) (*DocumentPreview, string) {
	file := files["word/document.xml"]
	raw, ok := readZipEntry(file)
	if !ok {
		return nil, ""
	}
	decoder := xml.NewDecoder(strings.NewReader(string(raw)))
	var blocks []OfficeBlock
	var flatLines []string
	var title string

	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		start, isStart := tok.(xml.StartElement)
		if !isStart {
			continue
		}
		if start.Name.Local != "body" {
			continue
		}
		for len(blocks) < maxOfficeBlocks {
			childTok, err := decoder.Token()
			if err != nil {
				break
			}
			switch elem := childTok.(type) {
			case xml.EndElement:
				if elem.Name.Local == "body" {
					goto done
				}
			case xml.StartElement:
				switch elem.Name.Local {
				case "p":
					kind, text := readDocxParagraph(decoder)
					text = strings.TrimSpace(text)
					if text != "" {
						if title == "" && kind == "h1" {
							title = text
						}
						blocks = append(blocks, OfficeBlock{Kind: kind, Text: text})
						flatLines = append(flatLines, text)
					}
				case "tbl":
					rows := readDocxTable(decoder)
					if len(rows) > 0 {
						blocks = append(blocks, OfficeBlock{Kind: "table", Rows: rows})
						for _, row := range rows {
							flatLines = append(flatLines, strings.Join(row, "\t"))
						}
					}
				default:
					_ = decoder.Skip()
				}
			}
		}
		break
	}
done:
	if len(blocks) == 0 {
		fallback := xmlTextRaw(raw, []string{"</w:p>", "</w:tr>"})
		if fallback == "" {
			return nil, ""
		}
		return &DocumentPreview{Blocks: []OfficeBlock{{Kind: "p", Text: fallback}}}, fallback
	}
	return &DocumentPreview{Title: title, Blocks: blocks}, strings.Join(flatLines, "\n\n")
}

func readDocxParagraph(decoder *xml.Decoder) (string, string) {
	kind := "p"
	var buf strings.Builder
	depth := 1
	inText := false
	for depth > 0 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch t.Name.Local {
			case "pStyle":
				for _, attr := range t.Attr {
					if attr.Name.Local == "val" {
						val := strings.ToLower(attr.Value)
						switch {
						case strings.Contains(val, "heading1") || strings.Contains(val, "title"):
							kind = "h1"
						case strings.Contains(val, "heading") || strings.Contains(val, "subtitle"):
							kind = "h2"
						case strings.Contains(val, "quote"):
							kind = "quote"
						}
					}
				}
			case "t":
				inText = true
			case "tab":
				buf.WriteByte('\t')
			case "br":
				buf.WriteByte('\n')
			}
		case xml.EndElement:
			if t.Name.Local == "t" {
				inText = false
			}
			depth--
		case xml.CharData:
			if inText {
				buf.Write(t)
			}
		}
	}
	return kind, buf.String()
}

func readDocxTable(decoder *xml.Decoder) [][]string {
	var rows [][]string
	depth := 1
	for depth > 0 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "tr" && depth == 1 && len(rows) < 60 {
				row := readDocxTableRow(decoder)
				if len(row) > 0 {
					rows = append(rows, row)
				}
			} else {
				depth++
			}
		case xml.EndElement:
			depth--
		}
	}
	return rows
}

func readDocxTableRow(decoder *xml.Decoder) []string {
	var cells []string
	depth := 1
	for depth > 0 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "tc" && depth == 1 && len(cells) < 20 {
				cells = append(cells, readDocxTableCell(decoder))
			} else {
				depth++
			}
		case xml.EndElement:
			depth--
		}
	}
	return cells
}

func readDocxTableCell(decoder *xml.Decoder) string {
	var parts []string
	depth := 1
	for depth > 0 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "p" && depth == 1 {
				_, text := readDocxParagraph(decoder)
				text = strings.TrimSpace(text)
				if text != "" {
					parts = append(parts, text)
				}
			} else {
				depth++
			}
		case xml.EndElement:
			depth--
		}
	}
	return strings.Join(parts, "\n")
}

func parseXlsx(files map[string]*zip.File) (*WorkbookPreview, string) {
	shared := parseXlsxSharedStrings(files["xl/sharedStrings.xml"])
	rels := parseXlsxRels(files["xl/_rels/workbook.xml.rels"])
	sheetSpecs := parseXlsxWorkbookSheets(files["xl/workbook.xml"])

	var sheets []SheetPreview
	var flatLines []string

	for _, spec := range sheetSpecs {
		if len(sheets) >= maxOfficeSheets {
			break
		}
		target := rels[spec.RelID]
		if target == "" {
			continue
		}
		entryName := strings.TrimPrefix(target, "/")
		if !strings.HasPrefix(entryName, "xl/") {
			entryName = path.Clean("xl/" + entryName)
		}
		sheetFile := files[entryName]
		if sheetFile == nil {
			continue
		}
		rows, formulas := parseXlsxWorksheet(sheetFile, shared)
		name := spec.Name
		if name == "" {
			name = "Sheet" + strconv.Itoa(len(sheets)+1)
		}
		sheets = append(sheets, SheetPreview{Name: name, Rows: rows, Formulas: formulas})
		flatLines = append(flatLines, "# "+name)
		for _, row := range rows {
			line := strings.TrimSpace(strings.Join(row, "\t"))
			if line != "" {
				flatLines = append(flatLines, line)
			}
		}
	}
	if len(sheets) == 0 {
		if len(shared) == 0 {
			return nil, ""
		}
		return nil, strings.Join(shared, "\n")
	}
	return &WorkbookPreview{Sheets: sheets}, strings.Join(flatLines, "\n")
}

type xlsxSheetSpec struct {
	Name  string
	RelID string
}

func parseXlsxSharedStrings(file *zip.File) []string {
	raw, ok := readZipEntry(file)
	if !ok {
		return nil
	}
	decoder := xml.NewDecoder(strings.NewReader(string(raw)))
	var shared []string
	var current strings.Builder
	inSI := false
	inT := false
	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "si" {
				inSI = true
				current.Reset()
			} else if inSI && t.Name.Local == "t" {
				inT = true
			}
		case xml.EndElement:
			if t.Name.Local == "t" {
				inT = false
			} else if t.Name.Local == "si" {
				inSI = false
				shared = append(shared, current.String())
			}
		case xml.CharData:
			if inSI && inT {
				current.Write(t)
			}
		}
	}
	return shared
}

func parseXlsxRels(file *zip.File) map[string]string {
	rels := map[string]string{}
	raw, ok := readZipEntry(file)
	if !ok {
		return rels
	}
	decoder := xml.NewDecoder(strings.NewReader(string(raw)))
	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		if start, ok := tok.(xml.StartElement); ok && start.Name.Local == "Relationship" {
			var id, target string
			for _, attr := range start.Attr {
				switch attr.Name.Local {
				case "Id":
					id = attr.Value
				case "Target":
					target = attr.Value
				}
			}
			if id != "" && target != "" {
				rels[id] = target
			}
		}
	}
	return rels
}

func parseXlsxWorkbookSheets(file *zip.File) []xlsxSheetSpec {
	raw, ok := readZipEntry(file)
	if !ok {
		return nil
	}
	decoder := xml.NewDecoder(strings.NewReader(string(raw)))
	var specs []xlsxSheetSpec
	for {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		if start, ok := tok.(xml.StartElement); ok && start.Name.Local == "sheet" {
			var spec xlsxSheetSpec
			for _, attr := range start.Attr {
				switch attr.Name.Local {
				case "name":
					spec.Name = attr.Value
				case "id":
					spec.RelID = attr.Value
				}
			}
			if spec.RelID != "" {
				specs = append(specs, spec)
			}
		}
	}
	return specs
}

func parseXlsxWorksheet(file *zip.File, shared []string) ([][]string, map[string]string) {
	raw, ok := readZipEntry(file)
	if !ok {
		return nil, nil
	}
	decoder := xml.NewDecoder(strings.NewReader(string(raw)))
	rowMap := map[int]map[int]string{}
	formulas := map[string]string{}
	maxRow := -1
	maxCol := -1
	cellCount := 0

	for cellCount < 10000 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		start, isStart := tok.(xml.StartElement)
		if !isStart || start.Name.Local != "c" {
			continue
		}
		cellCount++
		var ref, cellType string
		for _, attr := range start.Attr {
			switch attr.Name.Local {
			case "r":
				ref = attr.Value
			case "t":
				cellType = attr.Value
			}
		}
		rowIdx, colIdx, valid := parseCellRef(ref)
		val, formula := readXlsxCell(decoder, cellType, shared)
		if !valid || rowIdx >= maxSheetRows || colIdx >= maxSheetCols {
			continue
		}
		if rowIdx > maxRow {
			maxRow = rowIdx
		}
		if colIdx > maxCol {
			maxCol = colIdx
		}
		if rowMap[rowIdx] == nil {
			rowMap[rowIdx] = map[int]string{}
		}
		rowMap[rowIdx][colIdx] = val
		if formula != "" {
			formulas[ref] = "=" + formula
		}
	}

	if maxRow < 0 || maxCol < 0 {
		return [][]string{}, nil
	}
	rows := make([][]string, maxRow+1)
	for r := 0; r <= maxRow; r++ {
		line := make([]string, maxCol+1)
		for c, v := range rowMap[r] {
			line[c] = v
		}
		rows[r] = line
	}
	if len(formulas) == 0 {
		formulas = nil
	}
	return rows, formulas
}

func readXlsxCell(decoder *xml.Decoder, cellType string, shared []string) (string, string) {
	var valBuf, inlineBuf, formulaBuf strings.Builder
	depth := 1
	mode := ""
	for depth > 0 {
		tok, err := decoder.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch t.Name.Local {
			case "v":
				mode = "v"
			case "t":
				mode = "t"
			case "f":
				mode = "f"
			}
		case xml.EndElement:
			if t.Name.Local == "v" || t.Name.Local == "t" || t.Name.Local == "f" {
				mode = ""
			}
			depth--
		case xml.CharData:
			switch mode {
			case "v":
				valBuf.Write(t)
			case "t":
				inlineBuf.Write(t)
			case "f":
				formulaBuf.Write(t)
			}
		}
	}
	value := valBuf.String()
	switch cellType {
	case "s":
		if idx, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && idx >= 0 && idx < len(shared) {
			value = shared[idx]
		} else {
			value = ""
		}
	case "inlineStr":
		value = inlineBuf.String()
	case "b":
		if strings.TrimSpace(value) == "1" {
			value = "TRUE"
		} else {
			value = "FALSE"
		}
	}
	return value, strings.TrimSpace(formulaBuf.String())
}

func parseCellRef(ref string) (int, int, bool) {
	matches := cellRefPattern.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(ref)))
	if len(matches) != 3 {
		return 0, 0, false
	}
	col := 0
	for i := 0; i < len(matches[1]); i++ {
		col = col*26 + int(matches[1][i]-'A') + 1
	}
	row, err := strconv.Atoi(matches[2])
	if err != nil || row <= 0 || col <= 0 {
		return 0, 0, false
	}
	return row - 1, col - 1, true
}

func parsePptx(files map[string]*zip.File) (*PresentationPreview, string) {
	type slideEntry struct {
		num  int
		name string
	}
	var entries []slideEntry
	for name := range files {
		if strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml") {
			num := len(entries) + 1
			if m := slideNumRegex.FindStringSubmatch(name); len(m) == 2 {
				if parsed, err := strconv.Atoi(m[1]); err == nil {
					num = parsed
				}
			}
			entries = append(entries, slideEntry{num: num, name: name})
		}
	}
	if len(entries) == 0 {
		return nil, ""
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].num != entries[j].num {
			return entries[i].num < entries[j].num
		}
		return entries[i].name < entries[j].name
	})
	if len(entries) > maxOfficeSlides {
		entries = entries[:maxOfficeSlides]
	}
	slides := make([]SlidePreview, 0, len(entries))
	flatParts := make([]string, 0, len(entries))
	for idx, entry := range entries {
		raw, ok := readZipEntry(files[entry.name])
		if !ok {
			continue
		}
		text := xmlTextRaw(raw, []string{"</a:p>"})
		if text == "" {
			continue
		}
		rawLines := strings.Split(text, "\n")
		lines := make([]string, 0, len(rawLines))
		for _, line := range rawLines {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" {
				lines = append(lines, trimmed)
			}
		}
		if len(lines) == 0 {
			continue
		}
		title := lines[0]
		body := lines[1:]
		slides = append(slides, SlidePreview{
			Number: idx + 1,
			Title:  title,
			Lines:  body,
		})
		flatParts = append(flatParts, text)
	}
	if len(slides) == 0 {
		return nil, ""
	}
	return &PresentationPreview{Slides: slides}, strings.Join(flatParts, "\n\n")
}

func xmlTextRaw(raw []byte, breaks []string) string {
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
