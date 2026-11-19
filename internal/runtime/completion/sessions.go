package completion

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

const (
	sessionCandidateLimit = 10
	sessionCacheTTL       = 45 * time.Second
	sessionCacheDepth     = 50
)

type sessionCacheDocument struct {
	At       int64           `json:"at"`
	Sessions []sessionRecord `json:"sessions"`
}

type sessionRecord struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	UpdatedAt   json.RawMessage `json:"updatedAt"`
	Live        bool            `json:"live,omitempty"`
	Provider    string          `json:"provider,omitempty"`
	ProjectPath string          `json:"projectPath,omitempty"`
}

func sessionCacheFile(aiHome, key string) string {
	home := strings.TrimSpace(aiHome)
	if home == "" {
		return ""
	}
	var builder strings.Builder
	for _, char := range key {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9',
			char == '_', char == '.', char == '-':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
	}
	return filepath.Join(home, "run", "cache", "complete", "sessions-"+builder.String()+".json")
}

func readSessionCache(aiHome, key string, now time.Time) []sessionRecord {
	file := sessionCacheFile(aiHome, key)
	if file == "" {
		return nil
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var document sessionCacheDocument
	if json.Unmarshal(raw, &document) != nil || document.At <= 0 {
		return nil
	}
	if now.Sub(time.UnixMilli(document.At)) > sessionCacheTTL {
		return nil
	}
	return document.Sessions
}

func writeSessionCache(aiHome, key string, sessions []sessionRecord, now time.Time) {
	file := sessionCacheFile(aiHome, key)
	if file == "" {
		return
	}
	payload, err := json.Marshal(sessionCacheDocument{At: now.UnixMilli(), Sessions: sessions})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return
	}
	_ = os.WriteFile(file, payload, 0o600)
}

func jsonScalarString(raw json.RawMessage) string {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return ""
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
		return ""
	}
	var numeric json.Number
	if json.Unmarshal(raw, &numeric) == nil {
		return numeric.String()
	}
	return text
}

func jsonScalarInt64(raw json.RawMessage) int64 {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return 0
	}
	if strings.HasPrefix(text, `"`) {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			text = value
		}
	}
	numeric, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0
	}
	return int64(numeric)
}

func selectSessionCandidates(sessions []sessionRecord, current string, limit int) []sessionChoice {
	if limit < 1 {
		limit = sessionCandidateLimit
	}
	needle := strings.ToLower(strings.TrimSpace(current))
	selected := make([]sessionRecord, 0, len(sessions))
	if needle == "" {
		for _, session := range sessions {
			selected = append(selected, session)
			if len(selected) >= limit {
				break
			}
		}
	} else {
		for _, session := range sessions {
			id := strings.ToLower(session.ID)
			title := strings.ToLower(session.Title)
			if !strings.Contains(id, needle) && !strings.Contains(title, needle) {
				continue
			}
			selected = append(selected, session)
			if len(selected) >= maximum(limit, 20) {
				break
			}
		}
	}
	result := make([]sessionChoice, 0, len(selected))
	for _, session := range selected {
		id := strings.TrimSpace(session.ID)
		if id == "" {
			continue
		}
		result = append(result, sessionChoice{
			ID:        id,
			Title:     strings.TrimSpace(session.Title),
			UpdatedAt: jsonScalarString(session.UpdatedAt),
			Live:      session.Live,
		})
	}
	return result
}

func maximum(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// listProviderSessions 读取该 Provider 的会话候选（带 45 秒本地缓存）。
func listProviderSessions(environment Environment, aiHome, hostHome, provider, accountRef, current string, limit int) []sessionChoice {
	id := strings.ToLower(strings.TrimSpace(provider))
	if id == "" {
		return nil
	}
	if limit < 1 {
		limit = sessionCandidateLimit
	}
	cacheKey := id + "__" + strings.TrimSpace(accountRef)
	if cached := readSessionCache(aiHome, cacheKey, environment.now()); len(cached) > 0 {
		return selectSessionCandidates(cached, current, limit)
	}
	projects, err := sessionread.ListProjects(context.Background(), sessionread.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
	}, id)
	if err != nil {
		return nil
	}
	liveIDs := map[string]struct{}{}
	if strings.TrimSpace(accountRef) != "" {
		for _, entry := range sessionactivity.ListPersistentRegistryEntries(aiHome) {
			if entry.Provider == id && entry.AccountRef == strings.TrimSpace(accountRef) && entry.NativeSessionID != "" {
				liveIDs[entry.NativeSessionID] = struct{}{}
			}
		}
	}
	sessions := make([]sessionRecord, 0, 32)
	for _, project := range projects {
		for _, session := range project.Sessions {
			sessionID := strings.TrimSpace(session.ID)
			if sessionID == "" {
				continue
			}
			updatedAt := ""
			if session.UpdatedAt > 0 {
				updatedAt = strconv.FormatInt(session.UpdatedAt, 10)
			}
			raw, _ := json.Marshal(updatedAt)
			sessions = append(sessions, sessionRecord{
				ID:        sessionID,
				Title:     strings.TrimSpace(session.Title),
				UpdatedAt: raw,
				Live:      hasKey(liveIDs, sessionID),
			})
		}
	}
	sort.SliceStable(sessions, func(left, right int) bool {
		leftLive := sessions[left].Live
		rightLive := sessions[right].Live
		if leftLive != rightLive {
			return leftLive
		}
		leftTime := jsonScalarInt64(sessions[left].UpdatedAt)
		rightTime := jsonScalarInt64(sessions[right].UpdatedAt)
		if leftTime != rightTime {
			return rightTime < leftTime
		}
		return jsonScalarString(sessions[right].UpdatedAt) < jsonScalarString(sessions[left].UpdatedAt)
	})
	if len(sessions) > sessionCacheDepth {
		writeSessionCache(aiHome, cacheKey, sessions[:sessionCacheDepth], environment.now())
	} else {
		writeSessionCache(aiHome, cacheKey, sessions, environment.now())
	}
	return selectSessionCandidates(sessions, current, limit)
}

func hasKey(values map[string]struct{}, key string) bool {
	_, found := values[key]
	return found
}

// listResumeSessions 读取跨 Provider 的最近会话（与 aih resume 选择器同源）。
func listResumeSessions(environment Environment, aiHome, hostHome, current string) []resumeChoice {
	const cacheKey = "resume__all"
	if cached := readSessionCache(aiHome, cacheKey, environment.now()); len(cached) > 0 {
		return selectResumeCandidates(cached, current)
	}
	collected := make([]resumeChoice, 0, 64)
	lookup := make(map[string]int, 64)
	for _, provider := range sessionHistoryProviders() {
		projects, err := sessionread.ListProjects(context.Background(), sessionread.Options{
			AIHomeDir:   aiHome,
			HostHomeDir: hostHome,
		}, provider)
		if err != nil {
			continue
		}
		for _, project := range projects {
			for _, session := range project.Sessions {
				sessionID := strings.TrimSpace(session.ID)
				if sessionID == "" {
					continue
				}
				item := resumeChoice{
					ID:          sessionID,
					Title:       strings.TrimSpace(session.Title),
					UpdatedAt:   session.UpdatedAt,
					Provider:    strings.TrimSpace(project.Provider),
					ProjectPath: strings.TrimSpace(project.Path),
				}
				if position, exists := lookup[sessionID]; exists {
					if collected[position].Title == "" && item.Title != "" {
						collected[position] = item
					}
					continue
				}
				lookup[sessionID] = len(collected)
				collected = append(collected, item)
			}
		}
	}
	sort.SliceStable(collected, func(left, right int) bool {
		return collected[left].UpdatedAt > collected[right].UpdatedAt
	})
	records := make([]sessionRecord, 0, len(collected))
	for _, item := range collected {
		raw, _ := json.Marshal(item.UpdatedAt)
		records = append(records, sessionRecord{
			ID:          item.ID,
			Title:       item.Title,
			UpdatedAt:   raw,
			Provider:    item.Provider,
			ProjectPath: item.ProjectPath,
		})
	}
	if len(records) > sessionCacheDepth {
		writeSessionCache(aiHome, cacheKey, records[:sessionCacheDepth], environment.now())
	} else {
		writeSessionCache(aiHome, cacheKey, records, environment.now())
	}
	return selectResumeCandidates(records, current)
}

func selectResumeCandidates(records []sessionRecord, current string) []resumeChoice {
	needle := strings.ToLower(strings.TrimSpace(current))
	limit := sessionCandidateLimit
	if needle != "" {
		limit = maximum(sessionCandidateLimit, 20)
	}
	result := make([]resumeChoice, 0, len(records))
	for _, record := range records {
		if needle != "" {
			id := strings.ToLower(record.ID)
			title := strings.ToLower(record.Title)
			if !strings.Contains(id, needle) && !strings.Contains(title, needle) {
				continue
			}
		}
		result = append(result, resumeChoice{
			ID:          record.ID,
			Title:       record.Title,
			UpdatedAt:   jsonScalarInt64(record.UpdatedAt),
			Provider:    record.Provider,
			ProjectPath: record.ProjectPath,
		})
		if len(result) >= limit {
			break
		}
	}
	return result
}

// sessionHistoryProviders 返回 Go 会话读取器支持的 Provider 列表。
func sessionHistoryProviders() []string {
	seen := make(map[string]struct{}, 24)
	result := make([]string, 0, 24)
	for _, definition := range loadProviderSnapshot().definitions {
		for _, capability := range definition.Capabilities {
			if capability == providers.CapabilitySessionHistory {
				if _, exists := seen[definition.ID]; !exists {
					seen[definition.ID] = struct{}{}
					result = append(result, definition.ID)
				}
				break
			}
		}
	}
	for _, extra := range []string{"kimi", "chat"} {
		if _, exists := seen[extra]; !exists {
			seen[extra] = struct{}{}
			result = append(result, extra)
		}
	}
	return result
}
