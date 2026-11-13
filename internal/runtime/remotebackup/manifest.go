package remotebackup

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const (
	ManifestKind           = "aih-account-backup"
	ManifestVersion        = 1
	ManifestFileName       = "manifest.json"
	AccountsDirName        = "accounts"
	AccountDocumentKind    = "aih-accounts"
	AccountDocumentVersion = 1
)

var (
	validProviderPattern   = regexp.MustCompile(`^[a-z0-9._-]{1,64}$`)
	validAccountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
)

// ManifestSource 记录生成清单的主机标识。
type ManifestSource struct {
	Host string `json:"host"`
}

// ManifestEntry 记录清单中单个账号的内容摘要与删除标记（tombstone）。
type ManifestEntry struct {
	Provider string `json:"provider"`
	SHA256   string `json:"sha256"`
	Bytes    int    `json:"bytes"`
	Deleted  bool   `json:"deleted,omitempty"`
}

// Manifest 描述远端 backup/manifest.json 的增量状态索引。
type Manifest struct {
	Kind     string                   `json:"kind"`
	Version  int                      `json:"version"`
	Source   ManifestSource           `json:"source"`
	Revision int                      `json:"revision"`
	Accounts map[string]ManifestEntry `json:"accounts"`
}

// AccountDocument 是单账号 aih-accounts v1 备份文件结构（确定性序列化，不含时间戳）。
type AccountDocument struct {
	Kind     string          `json:"kind"`
	Version  int             `json:"version"`
	Accounts []AccountRecord `json:"accounts"`
}

// PlannedUpload 描述本轮需要写入远端的新增或变更账号文件。
type PlannedUpload struct {
	AccountRef string
	Provider   string
	Path       string
	Content    string
	SHA256     string
	Bytes      int
}

// BackupPlan 是 BuildBackupPlan 计算出的增量同步计划。
type BackupPlan struct {
	Uploads   []PlannedUpload
	Deleted   []string
	Unchanged int
	Manifest  Manifest
	Changed   bool
}

// StableStringify 按递归排序对象键名生成确定性紧凑 JSON，与 Node `stableStringify` 逐字节对齐
// （不转义 `<`、`>`、`&`，并将结构体内外一致地规范化）。
func StableStringify(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var generic any
	if err := decoder.Decode(&generic); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := writeStableJSON(&buf, generic); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func writeStableJSON(buf *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if typed {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		buf.WriteString(typed.String())
	case string:
		encoded, err := encodeJSONStringNoEscapeHTML(typed)
		if err != nil {
			return err
		}
		buf.Write(encoded)
	case []any:
		buf.WriteByte('[')
		for idx, item := range typed {
			if idx > 0 {
				buf.WriteByte(',')
			}
			if err := writeStableJSON(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for k := range typed {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for idx, k := range keys {
			if idx > 0 {
				buf.WriteByte(',')
			}
			encodedKey, err := encodeJSONStringNoEscapeHTML(k)
			if err != nil {
				return err
			}
			buf.Write(encodedKey)
			buf.WriteByte(':')
			if err := writeStableJSON(buf, typed[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		encoded, err := encodeJSONStringNoEscapeHTML(value)
		if err != nil {
			return err
		}
		buf.Write(encoded)
	}
	return nil
}

func encodeJSONStringNoEscapeHTML(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	out := buf.Bytes()
	return bytes.TrimSuffix(out, []byte("\n")), nil
}

// HashAccount 计算单条导出账号记录的 SHA-256 十六进制内容摘要。
func HashAccount(record AccountRecord) (string, error) {
	stable, err := StableStringify(record)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(stable))
	return hex.EncodeToString(sum[:]), nil
}

// AccountRelativePath 构造并严格校验 `accounts/<provider>/<accountRef>.json` 相对路径。
func AccountRelativePath(provider, accountRef string) (string, error) {
	providerID := strings.TrimSpace(provider)
	ref := strings.TrimSpace(accountRef)
	if !validProviderPattern.MatchString(providerID) {
		return "", errors.New("invalid_backup_provider")
	}
	if !validAccountRefPattern.MatchString(ref) {
		return "", errors.New("invalid_backup_account_ref")
	}
	return AccountsDirName + "/" + providerID + "/" + ref + ".json", nil
}

// BuildAccountDocument 包装单账号为确定性 aih-accounts v1 文档。
func BuildAccountDocument(record AccountRecord) AccountDocument {
	return AccountDocument{
		Kind:     AccountDocumentKind,
		Version:  AccountDocumentVersion,
		Accounts: []AccountRecord{record},
	}
}

// SerializeAccountDocument 生成 2 空格缩进且末尾带换行的确定性 JSON 文档（不转义 HTML 字符）。
func SerializeAccountDocument(record AccountRecord) (string, error) {
	doc := BuildAccountDocument(record)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// EmptyManifest 生成空的远端备份清单。
func EmptyManifest(hostName string) Manifest {
	return Manifest{
		Kind:     ManifestKind,
		Version:  ManifestVersion,
		Source:   ManifestSource{Host: strings.TrimSpace(hostName)},
		Revision: 0,
		Accounts: make(map[string]ManifestEntry),
	}
}

// ParseManifest 解析并规范化远端 manifest.json；空、损坏或版本不兼容均返回 ok=false。
func ParseManifest(text string) (*Manifest, bool) {
	trimmed := strings.TrimPrefix(text, "\ufeff")
	if strings.TrimSpace(trimmed) == "" {
		return nil, false
	}
	var raw struct {
		Kind    string `json:"kind"`
		Version int    `json:"version"`
		Source  *struct {
			Host string `json:"host"`
		} `json:"source"`
		Revision int `json:"revision"`
		Accounts map[string]struct {
			Provider string `json:"provider"`
			SHA256   string `json:"sha256"`
			Bytes    int    `json:"bytes"`
			Deleted  bool   `json:"deleted"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, false
	}
	if raw.Kind != ManifestKind || raw.Version != ManifestVersion {
		return nil, false
	}
	accounts := make(map[string]ManifestEntry, len(raw.Accounts))
	for ref, entry := range raw.Accounts {
		if !validAccountRefPattern.MatchString(ref) {
			continue
		}
		provider := strings.TrimSpace(entry.Provider)
		sha := strings.ToLower(strings.TrimSpace(entry.SHA256))
		if provider == "" || !sha256HexPattern.MatchString(sha) {
			continue
		}
		accounts[ref] = ManifestEntry{
			Provider: provider,
			SHA256:   sha,
			Bytes:    entry.Bytes,
			Deleted:  entry.Deleted,
		}
	}
	host := ""
	if raw.Source != nil {
		host = strings.TrimSpace(raw.Source.Host)
	}
	return &Manifest{
		Kind:     ManifestKind,
		Version:  ManifestVersion,
		Source:   ManifestSource{Host: host},
		Revision: raw.Revision,
		Accounts: accounts,
	}, true
}

// SerializeManifest 序列化远端清单（2 空格缩进 + 换行）。
func SerializeManifest(manifest Manifest) (string, error) {
	if manifest.Accounts == nil {
		manifest.Accounts = make(map[string]ManifestEntry)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(manifest); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// BuildBackupPlan 对比本地导出记录与远端清单，计算增量上传项与 tombstone 删除标记。
func BuildBackupPlan(accounts []AccountRecord, previous *Manifest, full bool, hostName string) (BackupPlan, error) {
	var prevAccounts map[string]ManifestEntry
	prevRevision := 0
	prevHost := ""
	if previous != nil {
		prevAccounts = previous.Accounts
		prevRevision = previous.Revision
		prevHost = previous.Source.Host
	}
	if prevAccounts == nil {
		prevAccounts = make(map[string]ManifestEntry)
	}

	nextAccounts := make(map[string]ManifestEntry, len(accounts)+len(prevAccounts))
	var uploads []PlannedUpload
	unchanged := 0

	for _, record := range accounts {
		ref := strings.TrimSpace(record.AccountRef)
		provider := strings.TrimSpace(record.Provider)
		if ref == "" || provider == "" {
			continue
		}
		relPath, err := AccountRelativePath(provider, ref)
		if err != nil {
			return BackupPlan{}, err
		}
		content, err := SerializeAccountDocument(record)
		if err != nil {
			return BackupPlan{}, err
		}
		sha, err := HashAccount(record)
		if err != nil {
			return BackupPlan{}, err
		}
		prior, hadPrior := prevAccounts[ref]
		if !full && hadPrior && !prior.Deleted && prior.SHA256 == sha {
			unchanged++
		} else {
			uploads = append(uploads, PlannedUpload{
				AccountRef: ref,
				Provider:   provider,
				Path:       relPath,
				Content:    content,
				SHA256:     sha,
				Bytes:      len(content),
			})
		}
		nextAccounts[ref] = ManifestEntry{
			Provider: provider,
			SHA256:   sha,
			Bytes:    len(content),
		}
	}

	var deleted []string
	prevKeys := make([]string, 0, len(prevAccounts))
	for k := range prevAccounts {
		prevKeys = append(prevKeys, k)
	}
	sort.Strings(prevKeys)
	for _, ref := range prevKeys {
		if _, exists := nextAccounts[ref]; exists {
			continue
		}
		prior := prevAccounts[ref]
		nextAccounts[ref] = ManifestEntry{
			Provider: prior.Provider,
			SHA256:   prior.SHA256,
			Bytes:    prior.Bytes,
			Deleted:  true,
		}
		if !prior.Deleted {
			deleted = append(deleted, ref)
		}
	}

	prevComp, err := StableStringify(prevAccounts)
	if err != nil {
		return BackupPlan{}, fmt.Errorf("比较旧清单失败: %w", err)
	}
	nextComp, err := StableStringify(nextAccounts)
	if err != nil {
		return BackupPlan{}, fmt.Errorf("比较新清单失败: %w", err)
	}
	changed := len(uploads) > 0 || prevComp != nextComp
	revision := prevRevision
	if changed {
		revision++
	}
	resolvedHost := strings.TrimSpace(hostName)
	if resolvedHost == "" {
		resolvedHost = strings.TrimSpace(prevHost)
	}

	return BackupPlan{
		Uploads:   uploads,
		Deleted:   deleted,
		Unchanged: unchanged,
		Manifest: Manifest{
			Kind:     ManifestKind,
			Version:  ManifestVersion,
			Source:   ManifestSource{Host: resolvedHost},
			Revision: revision,
			Accounts: nextAccounts,
		},
		Changed: changed,
	}, nil
}
