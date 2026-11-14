package pluginhost

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	// AccountSchemaVersion 是账号插件交换合同的版本号。
	AccountSchemaVersion = 1
	maxAccountSources    = 32
	maxProjectionFiles   = 64
	maxProjectionFileB   = 4 * 1024 * 1024
	maxResultBytes       = 8 * 1024 * 1024
)

var (
	providerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	sourceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,127}$`)
)

// AccountSource 描述单个归一化后的账号插件认证来源。
type AccountSource struct {
	SchemaVersion        int             `json:"schemaVersion"`
	ID                   string          `json:"id"`
	Kind                 string          `json:"kind"`
	AuthMode             string          `json:"authMode"`
	ClientDependent      bool            `json:"clientDependent"`
	RequiresApp          string          `json:"requiresApp"`
	DirectImport         bool            `json:"directImport"`
	Available            bool            `json:"available"`
	Description          string          `json:"description"`
	Identity             json.RawMessage `json:"identity"`
	Credential           json.RawMessage `json:"credential"`
	ProjectionID         string          `json:"projectionId"`
	LoginContribution    string          `json:"loginContribution"`
	PluginInstanceID     string          `json:"pluginInstanceId"`
	PluginContributionID string          `json:"pluginContributionId"`
	Provider             string          `json:"provider"`
	LoginAvailable       bool            `json:"loginAvailable"`
}

// ProjectionFile 描述插件返回的单个沙箱认证投影文件。
type ProjectionFile struct {
	Path     string
	Encoding string
	Content  string
	Mode     os.FileMode
}

type accountSourceMeta struct {
	InstanceID     string
	ContributionID string
	Provider       string
}

// normalizeAccountProvider 验证并归一化 provider 名称。
func normalizeAccountProvider(value string) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(value))
	if !providerPattern.MatchString(provider) {
		return "", pluginerr.New("account_plugin_provider_invalid", "非法 provider："+provider)
	}
	return provider, nil
}

// SafeRelativePath 校验路径是否为受控的相对路径（无 ..、无绝对路径、无控制字符）。
func SafeRelativePath(raw string) bool {
	trimmed := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if trimmed == "" || strings.HasPrefix(trimmed, "/") || strings.ContainsRune(trimmed, '\x00') {
		return false
	}
	if len(trimmed) >= 2 && trimmed[1] == ':' {
		return false
	}
	segments := strings.Split(trimmed, "/")
	for _, seg := range segments {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return path.Clean(trimmed) == trimmed
}

func validateResultSize(raw json.RawMessage, code string) error {
	if len(raw) > maxResultBytes {
		return pluginerr.New(code, "返回值超过大小上限")
	}
	return nil
}

func normalizeSourceListResult(raw json.RawMessage, meta accountSourceMeta) ([]AccountSource, error) {
	if strings.TrimSpace(string(raw)) == "" {
		return []AccountSource{}, nil
	}
	if err := validateResultSize(raw, "account_plugin_sources_invalid"); err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(raw))
	var rawSources []json.RawMessage
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal([]byte(trimmed), &rawSources); err != nil {
			return nil, pluginerr.New("account_plugin_sources_invalid", "来源列表不是合法数组")
		}
	} else if strings.HasPrefix(trimmed, "{") {
		var obj struct {
			Sources json.RawMessage `json:"sources"`
		}
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return nil, pluginerr.New("account_plugin_sources_invalid", "来源对象不是合法 JSON")
		}
		srcTrimmed := strings.TrimSpace(string(obj.Sources))
		if srcTrimmed != "" && srcTrimmed != "null" {
			if err := json.Unmarshal([]byte(srcTrimmed), &rawSources); err != nil {
				return nil, pluginerr.New("account_plugin_sources_invalid", "sources 必须是数组")
			}
		}
	} else {
		return []AccountSource{}, nil
	}
	if len(rawSources) > maxAccountSources {
		return nil, pluginerr.New("account_plugin_sources_too_many", "来源数量超过上限")
	}
	seen := make(map[string]struct{}, len(rawSources))
	out := make([]AccountSource, 0, len(rawSources))
	for _, itemRaw := range rawSources {
		src, err := normalizeAccountSource(itemRaw, meta)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[src.ID]; dup {
			return nil, pluginerr.New("account_plugin_source_duplicate", "来源 id 重复："+src.ID)
		}
		seen[src.ID] = struct{}{}
		out = append(out, src)
	}
	return out, nil
}

func normalizeAccountSource(raw json.RawMessage, meta accountSourceMeta) (AccountSource, error) {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return AccountSource{}, pluginerr.New("account_plugin_source_invalid", "来源必须是对象")
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return AccountSource{}, pluginerr.New("account_plugin_source_invalid", "来源 JSON 解析失败")
	}
	id := decodeStringField(obj["id"])
	if !sourceIDPattern.MatchString(id) {
		return AccountSource{}, pluginerr.New("account_plugin_source_id_invalid", "非法来源 id："+id)
	}
	kind := strings.ToLower(decodeStringField(obj["kind"]))
	if kind != "local" && kind != "remote" {
		return AccountSource{}, pluginerr.New("account_plugin_source_kind_invalid", fmt.Sprintf("来源 %s 的 kind 非法", id))
	}
	authMode := strings.ToLower(decodeStringField(obj["authMode"]))
	if authMode == "" {
		return AccountSource{}, pluginerr.New("account_plugin_source_auth_mode_invalid", fmt.Sprintf("来源 %s 缺少 authMode", id))
	}
	var clientDependent bool
	if err := json.Unmarshal(obj["clientDependent"], &clientDependent); err != nil {
		return AccountSource{}, pluginerr.New("account_plugin_source_invalid", fmt.Sprintf("来源 %s 必须声明 clientDependent", id))
	}
	requiresApp := decodeStringField(obj["requiresApp"])
	if requiresApp == "" {
		if reqRaw := bytesTrimmed(obj["requires"]); len(reqRaw) > 0 {
			var reqObj struct {
				App string `json:"app"`
			}
			if json.Unmarshal([]byte(reqRaw), &reqObj) == nil {
				requiresApp = strings.TrimSpace(reqObj.App)
			}
		}
	}
	if requiresApp == "" {
		requiresApp = decodeStringField(obj["app"])
	}
	var directImport bool
	_ = json.Unmarshal(obj["directImport"], &directImport)
	available := true
	if len(obj["available"]) > 0 && strings.TrimSpace(string(obj["available"])) != "null" {
		var b bool
		if json.Unmarshal(obj["available"], &b) == nil {
			available = b
		}
	}
	identity := normalizeOptionalJSON(obj["identity"])
	credential := normalizeOptionalJSON(obj["credential"])
	return AccountSource{
		SchemaVersion:        AccountSchemaVersion,
		ID:                   id,
		Kind:                 kind,
		AuthMode:             authMode,
		ClientDependent:      clientDependent,
		RequiresApp:          requiresApp,
		DirectImport:         directImport,
		Available:            available,
		Description:          decodeStringField(obj["description"]),
		Identity:             identity,
		Credential:           credential,
		ProjectionID:         decodeStringField(obj["projectionId"]),
		LoginContribution:    decodeStringField(obj["loginContribution"]),
		PluginInstanceID:     strings.TrimSpace(meta.InstanceID),
		PluginContributionID: strings.TrimSpace(meta.ContributionID),
		Provider:             strings.ToLower(strings.TrimSpace(meta.Provider)),
	}, nil
}

func normalizeProjectionFiles(raw json.RawMessage) ([]ProjectionFile, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return []ProjectionFile{}, nil
	}
	var rawList []json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &rawList); err != nil {
		return nil, pluginerr.New("account_plugin_files_invalid", "files 必须是数组")
	}
	if len(rawList) > maxProjectionFiles {
		return nil, pluginerr.New("account_plugin_files_too_many", "投影文件数量超过上限")
	}
	seen := make(map[string]struct{}, len(rawList))
	out := make([]ProjectionFile, 0, len(rawList))
	for _, itemRaw := range rawList {
		file, err := normalizeProjectionFile(itemRaw)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(file.Path)
		if _, dup := seen[key]; dup {
			return nil, pluginerr.New("account_plugin_file_duplicate", "文件重复："+file.Path)
		}
		seen[key] = struct{}{}
		out = append(out, file)
	}
	return out, nil
}

func normalizeProjectionFile(raw json.RawMessage) (ProjectionFile, error) {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return ProjectionFile{}, pluginerr.New("account_plugin_file_invalid", "文件项必须是对象")
	}
	var obj struct {
		Path     string `json:"path"`
		Encoding string `json:"encoding"`
		Content  any    `json:"content"`
	}
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return ProjectionFile{}, pluginerr.New("account_plugin_file_invalid", "文件项解析失败")
	}
	rel := strings.ReplaceAll(strings.TrimSpace(obj.Path), "\\", "/")
	if !SafeRelativePath(rel) {
		return ProjectionFile{}, pluginerr.New("account_plugin_file_path_invalid", "非法文件路径："+rel)
	}
	encoding := strings.ToLower(strings.TrimSpace(obj.Encoding))
	if encoding == "" {
		encoding = "utf8"
	}
	if encoding != "utf8" && encoding != "base64" {
		return ProjectionFile{}, pluginerr.New("account_plugin_file_encoding_invalid", "不支持的文件编码："+encoding)
	}
	content := ""
	if obj.Content != nil {
		content = fmt.Sprint(obj.Content)
	}
	var byteLen int
	if encoding == "base64" {
		trimmedB64 := strings.TrimRight(content, "=")
		byteLen = (len(trimmedB64) * 3) / 4
	} else {
		byteLen = len(content)
	}
	if byteLen > maxProjectionFileB {
		return ProjectionFile{}, pluginerr.New("account_plugin_file_too_large", fmt.Sprintf("文件 %s 超过 4MB", rel))
	}
	return ProjectionFile{
		Path:     rel,
		Encoding: encoding,
		Content:  content,
		Mode:     0o600,
	}, nil
}

type normalizedRefreshResult struct {
	Handled    bool
	Files      []ProjectionFile
	Credential json.RawMessage
	Rotated    bool
	ExpiresAt  int64
}

func normalizeRefreshResult(raw json.RawMessage) (*normalizedRefreshResult, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if err := validateResultSize(raw, "account_plugin_refresh_result_invalid"); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(trimmed, "{") {
		return &normalizedRefreshResult{}, nil
	}
	var obj struct {
		Handled    bool            `json:"handled"`
		Files      json.RawMessage `json:"files"`
		Credential json.RawMessage `json:"credential"`
		Rotated    bool            `json:"rotated"`
		ExpiresAt  float64         `json:"expiresAt"`
	}
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return nil, pluginerr.New("account_plugin_refresh_result_invalid", "刷新结果解析失败")
	}
	files, err := normalizeProjectionFiles(obj.Files)
	if err != nil {
		return nil, err
	}
	var exp int64
	if obj.ExpiresAt > 0 {
		exp = int64(obj.ExpiresAt + 0.5)
	}
	return &normalizedRefreshResult{
		Handled:    obj.Handled,
		Files:      files,
		Credential: normalizeObjectJSON(obj.Credential),
		Rotated:    obj.Rotated,
		ExpiresAt:  exp,
	}, nil
}

type normalizedMaterializeResult struct {
	Handled bool
	Files   []ProjectionFile
	Removed []string
}

func normalizeMaterializeResult(raw json.RawMessage) (normalizedMaterializeResult, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return normalizedMaterializeResult{Handled: true, Files: []ProjectionFile{}, Removed: []string{}}, nil
	}
	if err := validateResultSize(raw, "account_plugin_materialize_result_invalid"); err != nil {
		return normalizedMaterializeResult{}, err
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return normalizedMaterializeResult{}, pluginerr.New("account_plugin_materialize_result_invalid", "物化结果不是合法 JSON 对象")
	}
	handled := true
	if len(obj["handled"]) > 0 && strings.TrimSpace(string(obj["handled"])) != "null" {
		var b bool
		if json.Unmarshal(obj["handled"], &b) == nil {
			handled = b
		}
	}
	files, err := normalizeProjectionFiles(obj["files"])
	if err != nil {
		return normalizedMaterializeResult{}, err
	}
	var removed []string
	if remTrim := strings.TrimSpace(string(obj["removed"])); remTrim != "" && remTrim != "null" {
		var rawRem []string
		if err := json.Unmarshal([]byte(remTrim), &rawRem); err == nil {
			for _, item := range rawRem {
				rel := strings.ReplaceAll(strings.TrimSpace(item), "\\", "/")
				if !SafeRelativePath(rel) {
					return normalizedMaterializeResult{}, pluginerr.New("account_plugin_file_path_invalid", "非法移除路径："+rel)
				}
				removed = append(removed, rel)
			}
		}
	}
	if removed == nil {
		removed = []string{}
	}
	return normalizedMaterializeResult{
		Handled: handled,
		Files:   files,
		Removed: removed,
	}, nil
}

// WriteProjectionFiles 原子地把插件投影文件写入 runtimeDir 并按声明删除旧文件。
func WriteProjectionFiles(runtimeDir string, files []ProjectionFile, remove []string) ([]string, error) {
	trimmedRoot := strings.TrimSpace(runtimeDir)
	if trimmedRoot == "" {
		return nil, pluginerr.New("account_plugin_runtime_dir_missing", "缺少 runtimeDir")
	}
	root, err := filepath.Abs(trimmedRoot)
	if err != nil {
		return nil, pluginerr.New("account_plugin_runtime_dir_missing", "runtimeDir 路径无效")
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, pluginerr.New("account_plugin_runtime_dir_missing", "runtimeDir 目录不存在")
	}
	written := make([]string, 0, len(files))
	for _, file := range files {
		target := filepath.Join(append([]string{root}, strings.Split(file.Path, "/")...)...)
		rel, relErr := filepath.Rel(root, target)
		if relErr != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return nil, pluginerr.New("account_plugin_file_path_invalid", "非法文件路径："+file.Path)
		}
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o700); mkErr != nil {
			return nil, mkErr
		}
		var data []byte
		if file.Encoding == "base64" {
			data, err = base64.StdEncoding.DecodeString(file.Content)
			if err != nil {
				return nil, pluginerr.New("account_plugin_file_invalid", "base64 文件解码失败："+file.Path)
			}
		} else {
			data = []byte(file.Content)
		}
		mode := file.Mode
		if mode == 0 {
			mode = 0o600
		}
		var randBuf [6]byte
		_, _ = rand.Read(randBuf[:])
		temp := fmt.Sprintf("%s.%d.%s.tmp", target, os.Getpid(), hex.EncodeToString(randBuf[:]))
		if writeErr := os.WriteFile(temp, data, mode); writeErr != nil {
			return nil, writeErr
		}
		if renameErr := os.Rename(temp, target); renameErr != nil {
			_ = os.Remove(temp)
			return nil, renameErr
		}
		_ = os.Chmod(target, mode)
		written = append(written, file.Path)
	}
	for _, item := range remove {
		relPath := strings.ReplaceAll(strings.TrimSpace(item), "\\", "/")
		if !SafeRelativePath(relPath) {
			continue
		}
		target := filepath.Join(append([]string{root}, strings.Split(relPath, "/")...)...)
		rel, relErr := filepath.Rel(root, target)
		if relErr == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
			_ = os.RemoveAll(target)
		}
	}
	return written, nil
}

// RuntimeDigest 计算 runtimeDir 下文件的确定性 SHA-256 指纹，供 refresh 乐观锁防并发覆盖。
func RuntimeDigest(runtimeDir string) string {
	if strings.TrimSpace(runtimeDir) == "" {
		return ""
	}
	root, err := filepath.Abs(runtimeDir)
	if err != nil {
		return ""
	}
	if _, statErr := os.Stat(root); statErr != nil {
		return ""
	}
	hasher := sha256.New()
	_ = walkDigestDir(root, root, hasher)
	return hex.EncodeToString(hasher.Sum(nil))
}

func walkDigestDir(root, dir string, hasher interface{ Write([]byte) (int, error) }) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		target := filepath.Join(dir, entry.Name())
		rel, relErr := filepath.Rel(root, target)
		if relErr == nil {
			_, _ = hasher.Write([]byte(rel))
		}
		if entry.IsDir() {
			_ = walkDigestDir(root, target, hasher)
		} else if entry.Type()&fs.ModeType == 0 {
			data, readErr := os.ReadFile(target)
			if readErr != nil {
				_, _ = hasher.Write([]byte("unreadable"))
			} else {
				_, _ = hasher.Write(data)
			}
		}
	}
	return nil
}

func decodeStringField(raw json.RawMessage) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal([]byte(trimmed), &s); err == nil {
		return strings.TrimSpace(s)
	}
	return ""
}

func normalizeOptionalJSON(raw json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return json.RawMessage("null")
	}
	return json.RawMessage(trimmed)
}

func normalizeObjectJSON(raw json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	return json.RawMessage(trimmed)
}

func bytesTrimmed(raw json.RawMessage) string {
	s := strings.TrimSpace(string(raw))
	if s == "null" {
		return ""
	}
	return s
}
