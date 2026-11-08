package sshhost

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// FingerprintSHA256 生成 OpenSSH 风格的指纹：SHA256:base64（去掉尾部 =）。
func FingerprintSHA256(hostKey []byte) string {
	digest := sha256.Sum256(hostKey)
	return "SHA256:" + base64.StdEncoding.WithPadding(base64.NoPadding).EncodeToString(digest[:])
}

// HostID 是 TOFU 存储的键：host:port，主机名小写，端口缺省 22。
func HostID(host string, port int) string {
	if port == 0 {
		port = 22
	}
	return strings.ToLower(strings.TrimSpace(host)) + ":" + strconv.Itoa(port)
}

// HostKeyRecord 是首次信任时记下的主机指纹。
type HostKeyRecord struct {
	Fingerprint string `json:"fingerprint"`
	FirstSeenAt int64  `json:"firstSeenAt"`
}

// HostKeyRepository 是 TOFU 记录的持久化接口；Node 侧落在 app_kv 的 ssh_known_hosts 键。
type HostKeyRepository interface {
	All() map[string]HostKeyRecord
	Save(records map[string]HostKeyRecord) error
}

// MemoryHostKeyRepository 是进程内实现，供测试与无持久化场景使用。
type MemoryHostKeyRepository struct {
	records map[string]HostKeyRecord
}

// NewMemoryHostKeyRepository 创建空仓库。
func NewMemoryHostKeyRepository() *MemoryHostKeyRepository {
	return &MemoryHostKeyRepository{records: map[string]HostKeyRecord{}}
}

// All 返回记录副本。
func (repository *MemoryHostKeyRepository) All() map[string]HostKeyRecord {
	copied := make(map[string]HostKeyRecord, len(repository.records))
	for key, record := range repository.records {
		copied[key] = record
	}
	return copied
}

// Save 整体替换记录。
func (repository *MemoryHostKeyRepository) Save(records map[string]HostKeyRecord) error {
	copied := make(map[string]HostKeyRecord, len(records))
	for key, record := range records {
		copied[key] = record
	}
	repository.records = copied
	return nil
}

// TrustState 是主机指纹校验结果。
type TrustState string

const (
	// TrustFirstUse 表示首次见到该主机，已记录并放行。
	TrustFirstUse TrustState = "first_use"
	// TrustKnown 表示指纹与已记录的一致。
	TrustKnown TrustState = "known"
	// TrustMismatch 表示指纹变化，必须拒绝连接。
	TrustMismatch TrustState = "mismatch"
)

// HostKeyVerification 是 Verify 的结果。
type HostKeyVerification struct {
	State    TrustState
	Expected string
	Actual   string
}

// Trusted 表示是否放行。
func (verification HostKeyVerification) Trusted() bool {
	return verification.State == TrustFirstUse || verification.State == TrustKnown
}

// HostKeyStore 实现 TOFU：首次信任并落库，以后指纹变化一律拒绝。
type HostKeyStore struct {
	repository HostKeyRepository
	now        func() time.Time
}

// NewHostKeyStore 创建 TOFU 校验器；now 为空时用 time.Now。
func NewHostKeyStore(repository HostKeyRepository, now func() time.Time) *HostKeyStore {
	if now == nil {
		now = time.Now
	}
	return &HostKeyStore{repository: repository, now: now}
}

// Verify 校验主机公钥；仓库写入失败时按未信任处理（宁可连不上，也不静默跳过记录）。
func (store *HostKeyStore) Verify(host string, port int, hostKey []byte) (HostKeyVerification, error) {
	if store == nil || store.repository == nil {
		return HostKeyVerification{}, fmt.Errorf("host_key_store_unavailable")
	}
	identifier := HostID(host, port)
	actual := FingerprintSHA256(hostKey)
	records := store.repository.All()
	if records == nil {
		records = map[string]HostKeyRecord{}
	}
	known, found := records[identifier]
	if !found {
		records[identifier] = HostKeyRecord{Fingerprint: actual, FirstSeenAt: store.now().UnixMilli()}
		if err := store.repository.Save(records); err != nil {
			return HostKeyVerification{}, err
		}
		return HostKeyVerification{State: TrustFirstUse, Actual: actual}, nil
	}
	if known.Fingerprint == actual {
		return HostKeyVerification{State: TrustKnown, Expected: known.Fingerprint, Actual: actual}, nil
	}
	return HostKeyVerification{State: TrustMismatch, Expected: known.Fingerprint, Actual: actual}, nil
}

// Get 读取某主机已记录的指纹。
func (store *HostKeyStore) Get(host string, port int) (HostKeyRecord, bool) {
	if store == nil || store.repository == nil {
		return HostKeyRecord{}, false
	}
	record, found := store.repository.All()[HostID(host, port)]
	return record, found
}

// Forget 删除某主机的记录（用户在 SSH 开发机里「重新信任」）。
func (store *HostKeyStore) Forget(host string, port int) error {
	if store == nil || store.repository == nil {
		return fmt.Errorf("host_key_store_unavailable")
	}
	records := store.repository.All()
	delete(records, HostID(host, port))
	return store.repository.Save(records)
}

// KnownHostEntry 是 known_hosts 的一行。
type KnownHostEntry struct {
	Marker   string
	Patterns []string
	KeyType  string
	Key      []byte
	Line     int
}

// KnownHostMatch 是一次 known_hosts 命中。
type KnownHostMatch struct {
	Entry   KnownHostEntry
	Revoked bool
	CA      bool
}

// ParseKnownHosts 解析 OpenSSH known_hosts 文本。
//
// 支持注释 / 空行、@cert-authority / @revoked 标记、逗号分隔的多个模式（含 ! 否定）、
// 通配符与 |1|salt|hash 形式的哈希主机名。行数从 1 开始，便于报错定位。
func ParseKnownHosts(data []byte) ([]KnownHostEntry, error) {
	entries := make([]KnownHostEntry, 0)
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	for index, rawLine := range lines {
		lineNumber := index + 1
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		entry := KnownHostEntry{Line: lineNumber}
		if strings.HasPrefix(fields[0], "@") {
			entry.Marker = strings.TrimPrefix(fields[0], "@")
			fields = fields[1:]
		}
		if len(fields) < 3 {
			return nil, fmt.Errorf("known_hosts 第 %d 行字段不足", lineNumber)
		}
		entry.Patterns = strings.Split(fields[0], ",")
		entry.KeyType = fields[1]
		key, err := base64.StdEncoding.DecodeString(fields[2])
		if err != nil {
			return nil, fmt.Errorf("known_hosts 第 %d 行公钥无效: %w", lineNumber, err)
		}
		entry.Key = key
		entries = append(entries, entry)
	}
	return entries, nil
}

// MatchKnownHost 在已知条目里查找匹配 host:port 且公钥一致的一行。
//
// 返回的 Revoked / CA 供调用方决定拒绝还是当作 CA 校验；被 @revoked 命中同样返回。
func MatchKnownHost(entries []KnownHostEntry, host string, port int, keyType string, key []byte) (KnownHostMatch, bool) {
	candidate := host
	if port != 0 && port != 22 {
		candidate = fmt.Sprintf("[%s]:%d", host, port)
	}
	for _, entry := range entries {
		if !matchHostPatterns(entry.Patterns, candidate) {
			continue
		}
		if entry.KeyType != keyType {
			continue
		}
		if subtle.ConstantTimeCompare(entry.Key, key) != 1 {
			continue
		}
		return KnownHostMatch{
			Entry:   entry,
			Revoked: entry.Marker == "revoked",
			CA:      entry.Marker == "cert-authority",
		}, true
	}
	return KnownHostMatch{}, false
}

func matchHostPatterns(patterns []string, candidate string) bool {
	matched := false
	for _, rawPattern := range patterns {
		pattern := strings.TrimSpace(rawPattern)
		if pattern == "" {
			continue
		}
		if strings.HasPrefix(pattern, "!") {
			if matchHostPattern(strings.TrimPrefix(pattern, "!"), candidate) {
				return false
			}
			continue
		}
		if matchHostPattern(pattern, candidate) {
			matched = true
		}
	}
	return matched
}

// matchHostPattern 处理通配符与 |1|salt|hash 哈希主机名；大小写不敏感。
func matchHostPattern(pattern, candidate string) bool {
	if strings.HasPrefix(pattern, "|1|") {
		return matchHashedHost(pattern, candidate)
	}
	return wildcardMatch(strings.ToLower(pattern), strings.ToLower(candidate))
}

func matchHashedHost(pattern, candidate string) bool {
	parts := strings.Split(pattern, "|")
	// 形如 ["", "1", salt, hash]
	if len(parts) != 4 || parts[1] != "1" {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	mac := hmac.New(sha1.New, salt)
	_, _ = mac.Write([]byte(candidate))
	return hmac.Equal(mac.Sum(nil), expected)
}

// wildcardMatch 实现 OpenSSH 的 * 与 ? 通配（按 rune 匹配）。
func wildcardMatch(pattern, name string) bool {
	patternRunes := []rune(pattern)
	nameRunes := []rune(name)
	patternIndex, nameIndex := 0, 0
	starIndex, starNameIndex := -1, 0
	for nameIndex < len(nameRunes) {
		switch {
		case patternIndex < len(patternRunes) && (patternRunes[patternIndex] == '?' || patternRunes[patternIndex] == nameRunes[nameIndex]):
			patternIndex++
			nameIndex++
		case patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*':
			starIndex = patternIndex
			starNameIndex = nameIndex
			patternIndex++
		case starIndex >= 0:
			patternIndex = starIndex + 1
			starNameIndex++
			nameIndex = starNameIndex
		default:
			return false
		}
	}
	for patternIndex < len(patternRunes) && patternRunes[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(patternRunes)
}
