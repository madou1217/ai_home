package webuiaccountimportapi

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// 导入文档的解析结果码。与 Node 的 IMPORT_ERROR_TEXT 键逐字一致：
// job.logs 与 result.sourceResults 里出现的就是这些值。
const (
	importErrorInvalidJSON      = "invalid_json"
	importErrorUnsupportedShape = "unsupported_import_format"
	importErrorUnsupportedDoc   = "unsupported_document_version"
	importErrorInvalidDocument  = "invalid_document"
	// importErrorEmptyDocument 与旧链路里 Go 的 400 错误码同值：
	// 文档解析成功但没有任何账号时，整份来源记为失败。
	importErrorEmptyDocument = "empty_import_document"
	// importErrorMissingContent 是没有可解析来源时的作业级失败码。
	importErrorMissingContent = "missing_import_content"
)

// documentKind / documentVersion 是 aih-accounts 迁移文档的唯一版本。
const (
	documentKind    = "aih-accounts"
	documentVersion = 1
)

// pasteSourceName 是粘贴内容的来源名，日志与 sourceResults 都按它标注。
const pasteSourceName = "粘贴内容"

// importFilePattern 只接受账号文件；与 Node 的 /\.(json|txt)$/i 一致。
var importFilePattern = regexp.MustCompile(`(?i)\.(json|txt)$`)

// importDocument 是一个待解析的来源（上传文件或粘贴内容）。
type importDocument struct {
	Name    string
	Content string
}

// importPayload 是 WebUI 导入的上传合同。
//
// Files 保留原始 JSON：上传方可能传对象而不是数组，旧实现按「非数组」继续处理，
// 这里也不把结构不符当成整次请求失败（最终由「有没有可解析来源」决定）。
type importPayload struct {
	Name          string          `json:"name"`
	Mode          string          `json:"mode"`
	Files         json.RawMessage `json:"files"`
	File          *importFile     `json:"file"`
	Text          string          `json:"text"`
	Content       string          `json:"content"`
	ContentBase64 string          `json:"contentBase64"`
	Base64        string          `json:"base64"`
	Encoding      string          `json:"encoding"`
}

// importFile 是上传数组里的单个文件项。
type importFile struct {
	Name          string `json:"name"`
	Content       string `json:"content"`
	ContentBase64 string `json:"contentBase64"`
	Base64        string `json:"base64"`
	Encoding      string `json:"encoding"`
}

// normalizedFile 是解码后的上传文件。
type normalizedFile struct {
	name    string
	content []byte
}

// mode 返回作业展示用的导入方式，取值与 Node 一致。
func (payload importPayload) mode() string {
	if mode := strings.TrimSpace(payload.Mode); mode != "" {
		return mode
	}
	if payload.Content != "" {
		return "text"
	}
	return "json"
}

// collectDocuments 把上传负载展开成待解析来源。
//
// 顺序与 Node 的 collectImportDocuments 一致：粘贴内容优先，否则按上传文件
// （只认 .json / .txt）展开；两者都没有时返回空集合，由作业以
// missing_import_content 结束。
func (payload importPayload) collectDocuments() []importDocument {
	if !payload.hasFilesArray() && payload.ContentBase64 == "" {
		text := strings.TrimSpace(payload.Text)
		if text == "" {
			text = strings.TrimSpace(payload.Content)
		}
		if text != "" {
			return []importDocument{{Name: pasteSourceName, Content: text}}
		}
		return nil
	}
	files := payload.normalizedFiles()
	documents := make([]importDocument, 0, len(files))
	for _, file := range files {
		if !importFilePattern.MatchString(file.name) {
			continue
		}
		documents = append(documents, importDocument{
			Name:    file.name,
			Content: strings.ToValidUTF8(string(file.content), "\uFFFD"),
		})
	}
	return documents
}

// hasFilesArray 判断 files 是否是数组（含空数组）。
func (payload importPayload) hasFilesArray() bool {
	return strings.HasPrefix(strings.TrimSpace(string(payload.Files)), "[")
}

// normalizedFiles 解码上传条目，丢弃无法命名的空文件。
func (payload importPayload) normalizedFiles() []normalizedFile {
	items := make([]importFile, 0, 1)
	switch {
	case payload.hasFilesArray():
		var raw []json.RawMessage
		if err := json.Unmarshal(payload.Files, &raw); err != nil {
			return nil
		}
		for _, entry := range raw {
			var file importFile
			// 非对象条目按零值处理：旧实现同样把它们当成空文件丢弃，
			// 而不是让整次上传失败。
			_ = json.Unmarshal(entry, &file)
			items = append(items, file)
		}
	case payload.File != nil || payload.Content != "":
		items = append(items, importFile{
			Name:          payload.Name,
			Content:       payload.Content,
			ContentBase64: payload.ContentBase64,
			Base64:        payload.Base64,
			Encoding:      payload.Encoding,
		})
	}
	files := make([]normalizedFile, 0, len(items))
	for index, item := range items {
		name := safeUploadRelativePath(item.Name, "upload-"+strconv.Itoa(index+1)+".json")
		encoded := item.ContentBase64
		if encoded == "" {
			encoded = item.Base64
		}
		if encoded == "" && item.Encoding == "base64" {
			encoded = item.Content
		}
		content := []byte(item.Content)
		if encoded != "" {
			content = decodeBase64UploadContent(encoded)
		}
		if name == "" || len(content) == 0 {
			continue
		}
		files = append(files, normalizedFile{name: name, content: content})
	}
	return files
}

// safeUploadRelativePath 只保留相对路径里的普通段，拒绝目录穿越。
func safeUploadRelativePath(value, fallback string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		raw = fallback
	}
	raw = strings.ReplaceAll(raw, "\\", "/")
	parts := make([]string, 0, 4)
	for _, part := range strings.Split(strings.TrimLeft(raw, "/"), "/") {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return fallback
	}
	return strings.Join(parts, "/")
}

// decodeBase64UploadContent 解码 base64 上传内容。
//
// 浏览器可能带 data URL 前缀；Node 的 Buffer.from(..., 'base64') 对非法字符是
// 宽容的，这里同样先剔除非法字符再解码，避免一个空格把整份文件判成空。
func decodeBase64UploadContent(value string) []byte {
	text := value
	if index := strings.IndexByte(text, ','); index >= 0 && strings.HasPrefix(strings.ToLower(text), "data:") {
		text = text[index+1:]
	}
	cleaned := strings.Map(func(character rune) rune {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '+', character == '/', character == '=', character == '-', character == '_':
			return character
		}
		return -1
	}, text)
	cleaned = strings.NewReplacer("-", "+", "_", "/").Replace(cleaned)
	if decoded, err := base64.StdEncoding.DecodeString(cleaned); err == nil {
		return decoded
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(cleaned, "=")); err == nil {
		return decoded
	}
	return nil
}

// parseImportDocument 解析一份来源，返回账号条目或稳定错误码。
//
// 与 Node 的 parseNativeImportDocument 对齐：认 aih-accounts 文档、单账号对象
// 或账号数组，其它形态一律拒绝，不猜格式。
func parseImportDocument(content string) ([]accountsapi.AihAccountsImportEntry, string) {
	var value any
	if err := json.Unmarshal([]byte(strings.TrimPrefix(content, "\uFEFF")), &value); err != nil {
		return nil, importErrorInvalidJSON
	}
	switch typed := value.(type) {
	case map[string]any:
		if kind, _ := typed["kind"].(string); kind == documentKind {
			if !isDocumentVersionOne(typed["version"]) {
				return nil, importErrorUnsupportedDoc
			}
			accounts, ok := typed["accounts"].([]any)
			if !ok {
				return nil, importErrorInvalidDocument
			}
			return decodeImportEntries(accounts)
		}
		if !looksLikeNativeAccount(typed) {
			return nil, importErrorUnsupportedShape
		}
		return decodeImportEntries([]any{typed})
	case []any:
		for _, item := range typed {
			account, ok := item.(map[string]any)
			if !ok || !looksLikeNativeAccount(account) {
				return nil, importErrorUnsupportedShape
			}
		}
		return decodeImportEntries(typed)
	default:
		return nil, importErrorUnsupportedShape
	}
}

// decodeImportEntries 用严格结构解码条目；形状不符时整份文档无效。
func decodeImportEntries(accounts []any) ([]accountsapi.AihAccountsImportEntry, string) {
	raw, err := json.Marshal(accounts)
	if err != nil {
		return nil, importErrorInvalidDocument
	}
	var entries []accountsapi.AihAccountsImportEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, importErrorInvalidDocument
	}
	return entries, ""
}

// looksLikeNativeAccount 只判断「像一条账号记录」，不校验凭据内容。
func looksLikeNativeAccount(value map[string]any) bool {
	if _, ok := value["provider"].(string); !ok {
		return false
	}
	_, hasEnv := value["env"].(map[string]any)
	if hasEnv {
		return true
	}
	_, hasNativeAuth := value["nativeAuth"].(map[string]any)
	return hasNativeAuth
}

// isDocumentVersionOne 接受数字 1 与字符串 "1"（Node 用 Number() 比较）。
func isDocumentVersionOne(value any) bool {
	switch typed := value.(type) {
	case float64:
		return typed == documentVersion
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return err == nil && parsed == documentVersion
	default:
		return false
	}
}

// importErrorText 是错误码的中文说明；未登记的错误码原样输出。
var importErrorText = map[string]string{
	importErrorInvalidJSON:      "不是有效的 JSON",
	importErrorUnsupportedShape: "不是 aih 账号导出文件",
	importErrorUnsupportedDoc:   "导出文件版本不受支持",
	importErrorInvalidDocument:  "导出文件结构损坏",
}

// describeImportError 把错误码翻译成日志文案。
func describeImportError(code string) string {
	if text, ok := importErrorText[code]; ok {
		return text
	}
	return code
}
