package webuiaccountconfigapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const sqliteRowsLimit = 500

type credentialRecord struct {
	AccountRef          string
	Provider            string
	Env                 map[string]any
	NativeAuth          map[string]any
	EnvUpdatedAt        int64
	NativeAuthUpdatedAt int64
	UpdatedAt           int64
}

func (handler *Handler) readConfigFiles(ctx context.Context, provider string, accountRef string, mode string) (responseView, *apiError) {
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "account_config_read_failed", message: err.Error()}
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "account_config_read_failed", message: err.Error()}
	}
	if !found || strings.ToLower(strings.TrimSpace(owner)) != provider {
		return responseView{}, &apiError{
			status:  404,
			code:    "account_not_found",
			message: "未找到 " + provider + " 账号 " + accountRef,
		}
	}
	record, err := readCredentialRecord(ctx, databasePath, accountRef)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "account_config_read_failed", message: err.Error()}
	}
	if record != nil && record.Provider != "" && strings.ToLower(record.Provider) != provider {
		return responseView{}, &apiError{status: 404, code: "account_not_found", message: "账号 " + accountRef + " 不属于 " + provider}
	}

	files := make([]FileView, 0, 8)
	files = append(files, handler.credentialStoreFiles(provider, record, mode)...)
	runtimeDir := handler.projectionDir(provider, accountRef)
	files = append(files, handler.projectionFiles(provider, runtimeDir, mode)...)

	return responseView{
		OK:               true,
		Provider:         provider,
		AccountRef:       accountRef,
		Mode:             mode,
		RuntimeDirExists: runtimeDirExists(runtimeDir),
		Files:            files,
	}, nil
}

// projectionDir 与 Node getProfileDir 一致：claude 走宿主 home（网关模式），
// 不作为账号自有投影展示；其余 provider 用 run/auth-projections/<provider>/<ref>。
func (handler *Handler) projectionDir(provider string, accountRef string) string {
	if strings.ToLower(provider) == "claude" {
		return ""
	}
	return filepath.Join(handler.aiHomeDir, "run", "auth-projections", provider, accountRef)
}

func runtimeDirExists(directory string) bool {
	if directory == "" {
		return false
	}
	_, err := os.Stat(directory)
	return err == nil
}

func readCredentialRecord(ctx context.Context, databasePath string, accountRef string) (*credentialRecord, error) {
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = db.Close() }()

	var (
		ref                 string
		provider            string
		envJSON             string
		nativeJSON          string
		envUpdatedAt        sql.NullInt64
		nativeAuthUpdatedAt sql.NullInt64
		updatedAt           sql.NullInt64
	)
	err = db.QueryRowContext(ctx, `
		SELECT c.account_ref, r.provider, c.env_json, c.native_auth_json,
		       c.env_updated_at, c.native_auth_updated_at, c.updated_at
		FROM account_credentials c
		INNER JOIN account_refs r ON r.account_ref = c.account_ref
		WHERE c.account_ref = ?
		LIMIT 1`, accountRef).Scan(
		&ref, &provider, &envJSON, &nativeJSON, &envUpdatedAt, &nativeAuthUpdatedAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, err
	}
	return &credentialRecord{
		AccountRef:          ref,
		Provider:            provider,
		Env:                 parseObject(envJSON),
		NativeAuth:          parseObject(nativeJSON),
		EnvUpdatedAt:        envUpdatedAt.Int64,
		NativeAuthUpdatedAt: nativeAuthUpdatedAt.Int64,
		UpdatedAt:           updatedAt.Int64,
	}, nil
}

func parseObject(value string) map[string]any {
	if strings.TrimSpace(value) == "" {
		return map[string]any{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return map[string]any{}
	}
	if object, ok := parsed.(map[string]any); ok {
		return object
	}
	return map[string]any{}
}

func (handler *Handler) credentialStoreFiles(provider string, record *credentialRecord, mode string) []FileView {
	if record == nil {
		return nil
	}
	files := make([]FileView, 0, 2)
	nativeAuth := make(map[string]any, len(record.NativeAuth))
	for key, value := range record.NativeAuth {
		nativeAuth[key] = value
	}
	var decodedDatabase any
	if database, ok := nativeAuth["database"].(string); ok && database != "" {
		decodedBytes := decodeBase64Lenient(database)
		nativeAuth["database"] = sqliteNotice(len(decodedBytes))
		decodedDatabase = decodeSQLiteBase64(database)
	}
	storeView := map[string]any{
		"env":                 record.Env,
		"nativeAuth":          nativeAuth,
		"envUpdatedAt":        isoOrNil(record.EnvUpdatedAt),
		"nativeAuthUpdatedAt": isoOrNil(record.NativeAuthUpdatedAt),
	}
	content, fields := renderJSONContent(storeView, mode)
	files = append(files, FileView{
		ID:             "store:credentials",
		Label:          "账号凭据记录",
		Source:         "store",
		Location:       "app-state.db · account_credentials",
		Format:         "json",
		UpdatedAt:      record.UpdatedAt,
		Content:        content,
		RedactedFields: fields,
	})
	if decodedDatabase != nil {
		dbContent, dbFields := renderJSONContent(decodedDatabase, mode)
		label := "凭据数据库"
		if provider == "kiro" {
			label = "凭据数据库（kiro-cli data.sqlite3）"
		}
		files = append(files, FileView{
			ID:             "store:database",
			Label:          label,
			Source:         "store",
			Location:       "account_credentials.native_auth_json.database",
			Format:         "json",
			UpdatedAt:      record.NativeAuthUpdatedAt,
			Content:        dbContent,
			RedactedFields: dbFields,
		})
	}
	return files
}

func (handler *Handler) projectionFiles(provider string, runtimeDir string, mode string) []FileView {
	if runtimeDir == "" {
		return nil
	}
	root, err := filepath.Abs(runtimeDir)
	if err != nil {
		return nil
	}
	if _, statErr := os.Stat(root); statErr != nil {
		return nil
	}
	files := make([]FileView, 0, 8)
	for _, relativePath := range projectionCandidates(provider, handler.catalog) {
		absolute := filepath.Join(root, filepath.FromSlash(relativePath))
		if !strings.HasPrefix(absolute, root+string(filepath.Separator)) {
			continue
		}
		stat, statErr := os.Stat(absolute)
		if statErr != nil || !stat.Mode().IsRegular() {
			continue
		}
		extension := strings.ToLower(filepath.Ext(relativePath))
		size := stat.Size()
		base := FileView{
			ID:        "projection:" + relativePath,
			Label:     relativePath,
			Source:    "projection",
			Location:  "运行时投影 · " + relativePath,
			UpdatedAt: stat.ModTime().UnixMilli(),
			Size:      &size,
		}
		if isSQLiteExtension(extension) {
			if size > maxSQLiteBytes {
				continue
			}
			dumped, dumpErr := dumpKeyValueSQLite(absolute)
			if dumpErr != nil {
				dumped = map[string]any{"<error>": "数据库读取失败：" + dumpErr.Error()}
			}
			base.Format = "json"
			base.Content, base.RedactedFields = renderJSONContent(dumped, mode)
			files = append(files, base)
			continue
		}
		if size > maxFileBytes {
			base.Format = "text"
			base.Content = "<文件过大（" + formatInt64(size) + " 字节），未读取>\n"
			base.RedactedFields = []string{}
			files = append(files, base)
			continue
		}
		raw, readErr := os.ReadFile(absolute)
		if readErr != nil {
			continue
		}
		content := string(raw)
		format := detectFormat(extension, content)
		base.Format = format
		base.Content, base.RedactedFields = renderTextContent(content, format, mode)
		files = append(files, base)
	}
	return files
}

func detectFormat(extension string, content string) string {
	if format, ok := textFormatByExtension[extension]; ok {
		return format
	}
	trimmed := strings.TrimLeft(content, " \t\r\n")
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return "json"
	}
	return "text"
}

var textFormatByExtension = map[string]string{
	".json":  "json",
	".jsonc": "jsonc",
	".toml":  "toml",
	".yaml":  "yaml",
	".yml":   "yaml",
	".ini":   "ini",
	".conf":  "ini",
}

func isSQLiteExtension(extension string) bool {
	return extension == ".sqlite" || extension == ".sqlite3" || extension == ".db"
}

func renderJSONContent(value any, mode string) (string, []string) {
	content, err := marshalPretty(value)
	if err != nil {
		return "{}\n", []string{}
	}
	if mode == "raw" {
		return content, []string{}
	}
	return redactJSONText(content)
}

func renderTextContent(content string, format string, mode string) (string, []string) {
	if mode == "raw" {
		return content, []string{}
	}
	switch format {
	case "json":
		return redactJSONText(content)
	case "jsonc":
		return redactJSONC(content)
	case "text":
		return redactText(content)
	default:
		return redactLineBased(content)
	}
}

func isoOrNil(value int64) any {
	if value <= 0 {
		return nil
	}
	return time.UnixMilli(value).UTC().Format("2006-01-02T15:04:05.000Z")
}

func decodeBase64Lenient(value string) []byte {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', '\t', ' ':
			return -1
		default:
			return r
		}
	}, value)
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if decoded, err := encoding.DecodeString(cleaned); err == nil {
			return decoded
		}
	}
	return nil
}

func sqliteNotice(bytes int) string {
	return "<sqlite " + formatInt(bytes) + " 字节，解码内容见「凭据数据库」>"
}

func formatInt(value int) string {
	return formatInt64(int64(value))
}

func formatInt64(value int64) string {
	return jsonNumberString(value)
}

func jsonNumberString(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func marshalPretty(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return buffer.String(), nil
}

func encodeJSON(writer interface{ Write([]byte) (int, error) }, payload any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(payload)
}
