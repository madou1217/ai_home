package tokenrefreshdaemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	suppressionFileName       = "token-refresh-suppressions.json"
	suppressionStoreVersion   = 1
	maxSuppressionEntries     = 4096
	maxSuppressionReasonRunes = 240
)

// SuppressionEntry 记录单个账号因永久性 Refresh 失败而被抑制重试的摘要边界。
//
// 绝不保存 Access Token、Refresh Token 明文或其可逆编码；TokenDigest 仅存不可逆 SHA-256 摘要，
// 当新登录换来不同 Refresh Token 或重试期限到期时自动解除抑制。
type SuppressionEntry struct {
	AccountRef          string `json:"accountRef"`
	Provider            string `json:"provider"`
	TokenDigest         string `json:"tokenDigest"`
	CredentialUpdatedMS int64  `json:"credentialUpdatedAtMs,omitempty"`
	SuppressedAtMS      int64  `json:"suppressedAtMs"`
	RetryAtMS           int64  `json:"retryAtMs"`
	Reason              string `json:"reason,omitempty"`
}

type suppressionDocument struct {
	Version     int                         `json:"version"`
	UpdatedAtMS int64                       `json:"updatedAtMs"`
	Entries     map[string]SuppressionEntry `json:"entries"`
}

type suppressionStore struct {
	mu       sync.Mutex
	filePath string
	entries  map[string]SuppressionEntry
}

func newSuppressionStore(aiHomeDir string, now time.Time) *suppressionStore {
	trimmed := strings.TrimSpace(aiHomeDir)
	filePath := ""
	if trimmed != "" {
		filePath = filepath.Join(trimmed, "run", suppressionFileName)
	}
	store := &suppressionStore{
		filePath: filePath,
		entries:  make(map[string]SuppressionEntry),
	}
	store.load(now)
	return store
}

func (s *suppressionStore) load(now time.Time) {
	if s == nil || s.filePath == "" {
		return
	}
	raw, err := os.ReadFile(s.filePath)
	if err != nil || len(raw) == 0 {
		return
	}
	var doc suppressionDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return
	}
	if doc.Version != suppressionStoreVersion || len(doc.Entries) == 0 {
		return
	}
	nowMS := now.UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	for ref, entry := range doc.Entries {
		accountRef := strings.TrimSpace(entry.AccountRef)
		if accountRef == "" {
			accountRef = strings.TrimSpace(ref)
		}
		if accountRef == "" || entry.RetryAtMS <= nowMS {
			continue
		}
		entry.AccountRef = accountRef
		s.entries[accountRef] = entry
	}
}

func (s *suppressionStore) IsSuppressed(accountRef, digest string, credentialUpdatedAtMS int64, now time.Time) bool {
	if s == nil || strings.TrimSpace(accountRef) == "" {
		return false
	}
	nowMS := now.UnixMilli()
	s.mu.Lock()
	entry, exists := s.entries[accountRef]
	if !exists {
		s.mu.Unlock()
		return false
	}
	if entry.RetryAtMS <= nowMS {
		delete(s.entries, accountRef)
		_ = s.persistLocked(now)
		s.mu.Unlock()
		return false
	}
	if !suppressionMatches(entry, digest, credentialUpdatedAtMS) {
		delete(s.entries, accountRef)
		_ = s.persistLocked(now)
		s.mu.Unlock()
		return false
	}
	s.mu.Unlock()
	return true
}

func suppressionMatches(entry SuppressionEntry, digest string, credentialUpdatedAtMS int64) bool {
	if entry.TokenDigest != digest {
		return false
	}
	if digest == "" || digest == missingRefreshTokenDigest {
		if credentialUpdatedAtMS > 0 && entry.CredentialUpdatedMS != credentialUpdatedAtMS {
			return false
		}
	}
	return true
}

func (s *suppressionStore) Remember(
	accountRef string,
	provider string,
	digest string,
	credentialUpdatedAtMS int64,
	reason string,
	retryDelay time.Duration,
	now time.Time,
) {
	if s == nil || strings.TrimSpace(accountRef) == "" {
		return
	}
	if retryDelay <= 0 {
		retryDelay = DefaultSuppressionRetryDelay
	}
	nowMS := now.UnixMilli()
	entry := SuppressionEntry{
		AccountRef:          accountRef,
		Provider:            provider,
		TokenDigest:         digest,
		CredentialUpdatedMS: credentialUpdatedAtMS,
		SuppressedAtMS:      nowMS,
		RetryAtMS:           now.Add(retryDelay).UnixMilli(),
		Reason:              sanitizeReason(reason, maxSuppressionReasonRunes),
	}
	s.mu.Lock()
	s.entries[accountRef] = entry
	s.evictIfNeededLocked()
	_ = s.persistLocked(now)
	s.mu.Unlock()
}

func (s *suppressionStore) Clear(accountRef string, now time.Time) {
	if s == nil || strings.TrimSpace(accountRef) == "" {
		return
	}
	s.mu.Lock()
	if _, exists := s.entries[accountRef]; !exists {
		s.mu.Unlock()
		return
	}
	delete(s.entries, accountRef)
	_ = s.persistLocked(now)
	s.mu.Unlock()
}

func (s *suppressionStore) PruneMissing(validAccountRefs map[string]struct{}, now time.Time) {
	if s == nil {
		return
	}
	nowMS := now.UnixMilli()
	s.mu.Lock()
	changed := false
	for ref, entry := range s.entries {
		_, active := validAccountRefs[ref]
		if !active || entry.RetryAtMS <= nowMS {
			delete(s.entries, ref)
			changed = true
		}
	}
	if changed {
		_ = s.persistLocked(now)
	}
	s.mu.Unlock()
}

func (s *suppressionStore) Count(now time.Time) int {
	if s == nil {
		return 0
	}
	nowMS := now.UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, entry := range s.entries {
		if entry.RetryAtMS > nowMS {
			count++
		}
	}
	return count
}

func (s *suppressionStore) evictIfNeededLocked() {
	if len(s.entries) <= maxSuppressionEntries {
		return
	}
	type item struct {
		ref          string
		suppressedAt int64
	}
	items := make([]item, 0, len(s.entries))
	for ref, entry := range s.entries {
		items = append(items, item{ref: ref, suppressedAt: entry.SuppressedAtMS})
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].suppressedAt < items[j].suppressedAt
	})
	removeCount := len(items) - maxSuppressionEntries
	for i := 0; i < removeCount; i++ {
		delete(s.entries, items[i].ref)
	}
}

func (s *suppressionStore) persistLocked(now time.Time) error {
	if s.filePath == "" {
		return nil
	}
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	snapshot := make(map[string]SuppressionEntry, len(s.entries))
	for ref, entry := range s.entries {
		snapshot[ref] = entry
	}
	doc := suppressionDocument{
		Version:     suppressionStoreVersion,
		UpdatedAtMS: now.UnixMilli(),
		Entries:     snapshot,
	}
	payload, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	tmpFile, err := os.CreateTemp(dir, ".token-refresh-suppressions-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.Write(payload); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Chmod(0o600); err != nil {
		_ = tmpFile.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, s.filePath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func sanitizeReason(raw string, maxRunes int) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.ReplaceAll(trimmed, "\r", " ")
	trimmed = strings.ReplaceAll(trimmed, "\n", " ")
	if maxRunes <= 0 {
		return trimmed
	}
	runes := []rune(trimmed)
	if len(runes) <= maxRunes {
		return trimmed
	}
	return string(runes[:maxRunes])
}
