package webuitoolappsettingswriteapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolsettingsapi"
)

// maxConfigBytes 与 Node provider-config-manager 的 2MB 编辑上限一致。
const maxConfigBytes = 2 * 1024 * 1024

// maxHistoryEntries 与 Node provider-config-history 的上限一致。
const maxHistoryEntries = 30

// HostApplyResult 是 applyToHost 的执行结果（字段与 Node applyHostPermission 一致）。
type HostApplyResult struct {
	Supported   bool   `json:"supported"`
	Applied     bool   `json:"applied"`
	Changed     bool   `json:"changed"`
	Provider    string `json:"provider,omitempty"`
	FileID      string `json:"fileId,omitempty"`
	DisplayPath string `json:"displayPath,omitempty"`
	Revision    string `json:"revision,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

// hostApplyError 携带 Node 配置工作台的领域码。
type hostApplyError struct {
	code    string
	message string
}

func (err *hostApplyError) Error() string { return err.message }

// ApplyHostPermission 把「最大权限」写入宿主 CLI 自己的配置文件。
//
// 与 Node 的写入口保持同一组语义：读原文 → 打补丁 → 内容未变直接返回 →
// 写前复核 revision（冲突拒绝）→ 原子替换 → 追加版本历史。JSONC 的注释在
// Go 侧会被规范化掉（Node 的 jsonc-parser 会保留注释），这是本切片唯一的
// 格式差异；字段值本身仍按同一份补丁写入。
func ApplyHostPermission(
	definition providers.Definition,
	home string,
	lookupEnv func(string) string,
	aiHomeDir string,
) (HostApplyResult, error) {
	target, known, err := webuitoolsettingsapi.ResolveHostWriteTarget(definition, home, lookupEnv)
	if !known {
		return HostApplyResult{Supported: false, Applied: false, Changed: false, Reason: "host_profile_unsupported"}, nil
	}
	if err != nil {
		code := "host_config_unavailable"
		if typed, ok := err.(interface{ Error() string }); ok && strings.HasPrefix(typed.Error(), "provider_config_") {
			code = typed.Error()
		}
		return HostApplyResult{}, &hostApplyError{code: code, message: "宿主配置不可用"}
	}
	content, exists, err := readHostConfig(target.AbsolutePath)
	if err != nil {
		return HostApplyResult{}, err
	}
	patched, err := buildHostPermissionContent(content, target.Format, target.Patch)
	if err != nil {
		return HostApplyResult{}, err
	}
	revision := hashContent(content)
	if patched == content {
		return HostApplyResult{
			Supported: true, Applied: true, Changed: false,
			Provider: target.Provider, FileID: target.FileID,
			DisplayPath: target.DisplayPath, Revision: revision,
		}, nil
	}
	if !target.Writable {
		return HostApplyResult{}, &hostApplyError{code: "provider_config_not_writable", message: "当前用户没有写入该配置文件的权限"}
	}
	// 写前复核：从读到写之间被其他进程改过就拒绝，避免覆盖用户的并发编辑。
	latest, latestExists, err := readHostConfig(target.AbsolutePath)
	if err != nil {
		return HostApplyResult{}, err
	}
	if latest != content || latestExists != exists {
		return HostApplyResult{}, &hostApplyError{code: "provider_config_conflict", message: "配置文件在编辑期间已被其他进程修改，请重新读取后再保存"}
	}
	if err := writeHostConfig(target.AbsolutePath, patched); err != nil {
		return HostApplyResult{}, err
	}
	newRevision := hashContent(patched)
	if aiHomeDir != "" {
		appendHostHistory(aiHomeDir, target.Provider, target.FileID, content, exists, newRevision, patched)
	}
	return HostApplyResult{
		Supported: true, Applied: true, Changed: true,
		Provider: target.Provider, FileID: target.FileID,
		DisplayPath: target.DisplayPath, Revision: newRevision,
	}, nil
}

func readHostConfig(path string) (string, bool, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, &hostApplyError{code: "provider_config_read_failed", message: "读取配置失败"}
	}
	if info.Size() > maxConfigBytes {
		return "", false, &hostApplyError{code: "provider_config_too_large", message: "配置文件超过 2MB 编辑上限"}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false, &hostApplyError{code: "provider_config_read_failed", message: "读取配置失败"}
	}
	return string(data), true, nil
}

func writeHostConfig(path string, content string) error {
	mode := os.FileMode(0o600)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return &hostApplyError{code: "provider_config_save_failed", message: "创建配置目录失败"}
	}
	temp, err := os.CreateTemp(directory, ".aih-host-*.tmp")
	if err != nil {
		return &hostApplyError{code: "provider_config_save_failed", message: "保存配置失败"}
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if _, err := temp.WriteString(content); err != nil {
		_ = temp.Close()
		return &hostApplyError{code: "provider_config_save_failed", message: "保存配置失败"}
	}
	if err := temp.Close(); err != nil {
		return &hostApplyError{code: "provider_config_save_failed", message: "保存配置失败"}
	}
	_ = os.Chmod(tempPath, mode)
	if err := os.Rename(tempPath, path); err != nil {
		return &hostApplyError{code: "provider_config_save_failed", message: "保存配置失败"}
	}
	_ = os.Chmod(path, mode)
	return nil
}

func hashContent(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// buildHostPermissionContent 按配置格式写入补丁。
func buildHostPermissionContent(content string, format string, patch map[string]string) (string, error) {
	if strings.EqualFold(strings.TrimSpace(format), "toml") {
		return patchTomlTopLevel(content, patch)
	}
	return patchJSON(content, patch)
}

// patchTomlTopLevel 复用 Node 的文本替换口径：保留注释与其它段落，只替换顶层键。
func patchTomlTopLevel(content string, patch map[string]string) (string, error) {
	source := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(source, "\n")
	tableIndex := -1
	for index, line := range lines {
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), "[") {
			tableIndex = index
			break
		}
	}
	if tableIndex < 0 {
		tableIndex = len(lines)
	}
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	inserts := make([]string, 0)
	for _, key := range keys {
		if strings.Contains(key, ".") {
			return "", &hostApplyError{code: "nested_toml_permission_patch_unsupported", message: "嵌套 TOML 权限字段暂不支持"}
		}
		value, err := tomlLiteral(patch[key])
		if err != nil {
			return "", err
		}
		matched := false
		prefix := strings.TrimLeft(key, " \t")
		for index := 0; index < tableIndex; index++ {
			trimmed := strings.TrimLeft(lines[index], " \t")
			if !strings.HasPrefix(trimmed, prefix) {
				continue
			}
			rest := strings.TrimSpace(strings.TrimPrefix(trimmed, prefix))
			if !strings.HasPrefix(rest, "=") {
				continue
			}
			lines[index] = key + " = " + value
			matched = true
			break
		}
		if !matched {
			inserts = append(inserts, key+" = "+value)
		}
	}
	if len(inserts) > 0 {
		lines = append(inserts, lines...)
	}
	return strings.Join(lines, "\n"), nil
}

func tomlLiteral(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	switch strings.ToLower(trimmed) {
	case "true":
		return "true", nil
	case "false":
		return "false", nil
	}
	if _, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return trimmed, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", &hostApplyError{code: "provider_config_validation_failed", message: "权限字段无法序列化"}
	}
	return string(encoded), nil
}

// patchJSON 按点分路径写入字段；输入先去掉 JSONC 注释（Go 侧不保留注释）。
func patchJSON(content string, patch map[string]string) (string, error) {
	body := strings.TrimSpace(content)
	if body == "" {
		body = "{}"
	}
	normalized := stripJSONC(body)
	decoder := json.NewDecoder(strings.NewReader(normalized))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil || root == nil {
		return "", &hostApplyError{code: "provider_config_validation_failed", message: "配置语法不合法，未写入文件"}
	}
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, path := range keys {
		if err := setJSONPath(root, strings.Split(path, "."), patch[path]); err != nil {
			return "", err
		}
	}
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return "", &hostApplyError{code: "provider_config_validation_failed", message: "配置无法序列化"}
	}
	return string(encoded) + "\n", nil
}

func setJSONPath(root map[string]any, segments []string, value string) error {
	current := root
	for index, segment := range segments {
		if segment == "" {
			return &hostApplyError{code: "provider_config_validation_failed", message: "权限字段路径无效"}
		}
		if index == len(segments)-1 {
			current[segment] = value
			return nil
		}
		next, exists := current[segment]
		if !exists {
			child := map[string]any{}
			current[segment] = child
			current = child
			continue
		}
		child, ok := next.(map[string]any)
		if !ok {
			return &hostApplyError{code: "provider_config_validation_failed", message: "权限字段与现有配置结构冲突"}
		}
		current = child
	}
	return nil
}

// stripJSONC 去掉 // 与 /* */ 注释（字符串内的内容不受影响）。
func stripJSONC(content string) string {
	var builder strings.Builder
	builder.Grow(len(content))
	inString := false
	escaped := false
	for index := 0; index < len(content); index++ {
		char := content[index]
		if inString {
			builder.WriteByte(char)
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				inString = false
			}
			continue
		}
		if char == '"' {
			inString = true
			builder.WriteByte(char)
			continue
		}
		if char == '/' && index+1 < len(content) {
			if content[index+1] == '/' {
				index += 2
				for index < len(content) && content[index] != '\n' {
					index++
				}
				if index < len(content) {
					builder.WriteByte('\n')
				}
				continue
			}
			if content[index+1] == '*' {
				index += 2
				for index+1 < len(content) && !(content[index] == '*' && content[index+1] == '/') {
					index++
				}
				index++
				continue
			}
		}
		builder.WriteByte(char)
	}
	return builder.String()
}

// historyDocument 是 Node provider-config-history 的 JSON 结构。
type historyDocument struct {
	Version int            `json:"version"`
	Entries []historyEntry `json:"entries"`
}

type historyEntry struct {
	ID              string `json:"id"`
	Revision        string `json:"revision"`
	SavedAt         int64  `json:"savedAt"`
	Reason          string `json:"reason"`
	Note            string `json:"note"`
	Size            int    `json:"size"`
	ContainsSecrets bool   `json:"containsSecrets"`
	Content         string `json:"content"`
}

func safeSegment(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return ""
	}
	for _, char := range raw {
		valid := (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-'
		if !valid {
			return strings.ReplaceAll(strings.ReplaceAll(raw, "/", "%2F"), " ", "%20")
		}
	}
	return raw
}

func historyPath(aiHomeDir string, provider string, fileID string) string {
	return filepath.Join(aiHomeDir, "run", "provider-config-history", safeSegment(provider), safeSegment(fileID), "history.json")
}

func readHistoryDocument(path string) historyDocument {
	data, err := os.ReadFile(path)
	if err != nil {
		return historyDocument{Version: 1, Entries: []historyEntry{}}
	}
	var document historyDocument
	if err := json.Unmarshal(data, &document); err != nil || document.Entries == nil {
		return historyDocument{Version: 1, Entries: []historyEntry{}}
	}
	document.Version = 1
	return document
}

func writeHistoryDocument(path string, document historyDocument) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".history-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if _, err := temp.Write(append(encoded, '\n')); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tempPath, 0o600)
	return os.Rename(tempPath, path)
}

// appendHostHistory 与 Node 一致：首次写入前留 baseline，再追加本次保存。
func appendHostHistory(aiHomeDir string, provider string, fileID string, previous string, existed bool, revision string, content string) {
	path := historyPath(aiHomeDir, provider, fileID)
	document := readHistoryDocument(path)
	if existed && previous != "" && len(document.Entries) == 0 {
		document.Entries = append(document.Entries, newHistoryEntry(document, hashContent(previous), previous, "baseline", "首次通过 AIH 保存前的原始内容", true))
	}
	document.Entries = append(document.Entries, newHistoryEntry(document, revision, content, "save", "AIH：写入最大权限启动默认值", true))
	if len(document.Entries) > maxHistoryEntries {
		document.Entries = document.Entries[len(document.Entries)-maxHistoryEntries:]
	}
	document.Version = 1
	_ = writeHistoryDocument(path, document)
}

func newHistoryEntry(document historyDocument, revision string, content string, reason string, note string, containsSecrets bool) historyEntry {
	savedAt := time.Now().UnixMilli()
	if len(document.Entries) > 0 {
		last := document.Entries[len(document.Entries)-1].SavedAt
		if savedAt <= last {
			savedAt = last + 1
		}
	}
	short := revision
	if len(short) > 8 {
		short = short[:8]
	}
	return historyEntry{
		ID:              strconv.FormatInt(savedAt, 10) + "-" + short,
		Revision:        revision,
		SavedAt:         savedAt,
		Reason:          reason,
		Note:            note,
		Size:            len(content),
		ContainsSecrets: containsSecrets,
		Content:         content,
	}
}

