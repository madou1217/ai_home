// Package usageledger defines the durable, provider-neutral token usage facts
// emitted by successful inference attempts. It deliberately does not contain
// pricing, scans, or provider-specific quota snapshots.
package usageledger

import (
	"errors"
	"sort"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	ErrInvalidRecord = errors.New("usage ledger record invalid")
	ErrInvalidQuery  = errors.New("usage ledger query invalid")
)

type RecordInput struct {
	AccountRef accountcore.AccountRef
	Provider   string
	Model      string
	SessionID  string
	OccurredAt time.Time
	Usage      inference.Usage
}

type Record struct {
	accountRef accountcore.AccountRef
	provider   string
	model      string
	sessionID  string
	occurredAt time.Time
	usage      inference.Usage
}

func NewRecord(input RecordInput) (Record, error) {
	provider := strings.TrimSpace(strings.ToLower(input.Provider))
	model := strings.TrimSpace(input.Model)
	sessionID := strings.TrimSpace(input.SessionID)
	if !input.AccountRef.IsValid() || provider == "" || model == "" ||
		len(provider) > 64 || len(model) > 256 || len(sessionID) > 256 ||
		input.OccurredAt.IsZero() || input.OccurredAt.Location() != time.UTC ||
		!input.Usage.IsValid() || input.Usage.TotalTokens() == 0 {
		return Record{}, ErrInvalidRecord
	}
	return Record{
		accountRef: input.AccountRef,
		provider:   provider,
		model:      model,
		sessionID:  sessionID,
		occurredAt: time.UnixMilli(input.OccurredAt.UnixMilli()).UTC(),
		usage:      input.Usage,
	}, nil
}

func (record Record) AccountRef() accountcore.AccountRef { return record.accountRef }
func (record Record) Provider() string                   { return record.provider }
func (record Record) Model() string                      { return record.model }
func (record Record) SessionID() string                  { return record.sessionID }
func (record Record) OccurredAt() time.Time              { return record.occurredAt }
func (record Record) Usage() inference.Usage             { return record.usage }
func (record Record) IsValid() bool {
	_, err := NewRecord(RecordInput{
		AccountRef: record.accountRef,
		Provider:   record.provider,
		Model:      record.model,
		SessionID:  record.sessionID,
		OccurredAt: record.occurredAt,
		Usage:      record.usage,
	})
	return err == nil
}

type Query struct {
	From     time.Time
	To       time.Time
	Provider string
	Model    string
}

func (query Query) Validate() error {
	if query.From.IsZero() || query.To.IsZero() ||
		query.From.Location() != time.UTC || query.To.Location() != time.UTC ||
		query.To.Before(query.From) {
		return ErrInvalidQuery
	}
	if len(strings.TrimSpace(query.Provider)) > 64 || len(strings.TrimSpace(query.Model)) > 256 {
		return ErrInvalidQuery
	}
	return nil
}

type Stats struct {
	TotalCalls            uint64 `json:"total_calls"`
	TotalSessions         uint64 `json:"total_sessions"`
	InputTokens           uint64 `json:"input_tokens"`
	OutputTokens          uint64 `json:"output_tokens"`
	CacheReadInputTokens  uint64 `json:"cache_read_input_tokens"`
	CacheWriteInputTokens uint64 `json:"cache_write_input_tokens"`
	ReasoningOutputTokens uint64 `json:"reasoning_output_tokens"`
	TotalTokens           uint64 `json:"total_tokens"`
}

type ModelStats struct {
	Provider              string   `json:"provider"`
	Model                 string   `json:"model"`
	Calls                 uint64   `json:"calls"`
	InputTokens           uint64   `json:"input_tokens"`
	OutputTokens          uint64   `json:"output_tokens"`
	CacheReadInputTokens  uint64   `json:"cache_read_input_tokens"`
	CacheWriteInputTokens uint64   `json:"cache_creation_input_tokens"`
	ReasoningOutputTokens uint64   `json:"reasoning_output_tokens"`
	TotalTokens           uint64   `json:"total_tokens"`
	AccountCount          uint64   `json:"account_count"`
	AccountRefs           []string `json:"account_refs,omitempty"`
}

type SessionStats struct {
	Provider              string `json:"provider"`
	SessionID             string `json:"session_id"`
	Calls                 uint64 `json:"calls"`
	InputTokens           uint64 `json:"input_tokens"`
	OutputTokens          uint64 `json:"output_tokens"`
	CacheReadInputTokens  uint64 `json:"cache_read_input_tokens"`
	CacheWriteInputTokens uint64 `json:"cache_creation_input_tokens"`
	ReasoningOutputTokens uint64 `json:"reasoning_output_tokens"`
	TotalTokens           uint64 `json:"total_tokens"`
	AccountCount          uint64 `json:"account_count"`
}

func Aggregate(records []Record, query Query) Stats {
	if query.Validate() != nil {
		return Stats{}
	}
	provider := strings.TrimSpace(strings.ToLower(query.Provider))
	model := strings.TrimSpace(query.Model)
	sessions := make(map[string]struct{})
	var stats Stats
	for _, record := range records {
		if !record.IsValid() || record.OccurredAt().Before(query.From) || record.OccurredAt().After(query.To) {
			continue
		}
		if provider != "" && record.Provider() != provider || model != "" && record.Model() != model {
			continue
		}
		stats.TotalCalls++
		if sessionID := record.SessionID(); sessionID != "" {
			sessions[record.Provider()+"\x00"+sessionID] = struct{}{}
		}
		usage := record.Usage()
		stats.InputTokens += usage.InputTokens()
		stats.OutputTokens += usage.OutputTokens()
		stats.CacheReadInputTokens += usage.CachedInputTokens()
		stats.CacheWriteInputTokens += usage.CacheWriteInputTokens()
		stats.ReasoningOutputTokens += usage.ReasoningTokens()
		stats.TotalTokens += usage.TotalTokens()
	}
	stats.TotalSessions = uint64(len(sessions))
	return stats
}

func AggregateModels(records []Record, query Query) []ModelStats {
	if query.Validate() != nil {
		return nil
	}
	groups := make(map[string]*ModelStats)
	accounts := make(map[string]map[string]struct{})
	provider := strings.TrimSpace(strings.ToLower(query.Provider))
	model := strings.TrimSpace(query.Model)
	for _, record := range records {
		if !record.IsValid() || record.OccurredAt().Before(query.From) || record.OccurredAt().After(query.To) {
			continue
		}
		if provider != "" && record.Provider() != provider || model != "" && record.Model() != model {
			continue
		}
		key := record.Provider() + "\x00" + record.Model()
		item := groups[key]
		if item == nil {
			item = &ModelStats{Provider: record.Provider(), Model: record.Model()}
			groups[key] = item
			accounts[key] = make(map[string]struct{})
		}
		item.Calls++
		usage := record.Usage()
		item.InputTokens += usage.InputTokens()
		item.OutputTokens += usage.OutputTokens()
		item.CacheReadInputTokens += usage.CachedInputTokens()
		item.CacheWriteInputTokens += usage.CacheWriteInputTokens()
		item.ReasoningOutputTokens += usage.ReasoningTokens()
		item.TotalTokens += usage.TotalTokens()
		accounts[key][record.AccountRef().String()] = struct{}{}
	}
	models := make([]ModelStats, 0, len(groups))
	for key, item := range groups {
		item.AccountCount = uint64(len(accounts[key]))
		for ref := range accounts[key] {
			item.AccountRefs = append(item.AccountRefs, ref)
		}
		sort.Strings(item.AccountRefs)
		models = append(models, *item)
	}
	sort.Slice(models, func(left, right int) bool {
		if models[left].TotalTokens != models[right].TotalTokens {
			return models[left].TotalTokens > models[right].TotalTokens
		}
		if models[left].Provider != models[right].Provider {
			return models[left].Provider < models[right].Provider
		}
		return models[left].Model < models[right].Model
	})
	return models
}

func AggregateSessions(records []Record, query Query) []SessionStats {
	if query.Validate() != nil {
		return nil
	}
	groups := make(map[string]*SessionStats)
	accounts := make(map[string]map[string]struct{})
	provider := strings.TrimSpace(strings.ToLower(query.Provider))
	for _, record := range records {
		if !record.IsValid() || record.SessionID() == "" || record.OccurredAt().Before(query.From) || record.OccurredAt().After(query.To) {
			continue
		}
		if provider != "" && record.Provider() != provider || query.Model != "" && record.Model() != query.Model {
			continue
		}
		key := record.Provider() + "\x00" + record.SessionID()
		item := groups[key]
		if item == nil {
			item = &SessionStats{Provider: record.Provider(), SessionID: record.SessionID()}
			groups[key] = item
			accounts[key] = make(map[string]struct{})
		}
		item.Calls++
		usage := record.Usage()
		item.InputTokens += usage.InputTokens()
		item.OutputTokens += usage.OutputTokens()
		item.CacheReadInputTokens += usage.CachedInputTokens()
		item.CacheWriteInputTokens += usage.CacheWriteInputTokens()
		item.ReasoningOutputTokens += usage.ReasoningTokens()
		item.TotalTokens += usage.TotalTokens()
		accounts[key][record.AccountRef().String()] = struct{}{}
	}
	result := make([]SessionStats, 0, len(groups))
	for key, item := range groups {
		item.AccountCount = uint64(len(accounts[key]))
		result = append(result, *item)
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].TotalTokens != result[right].TotalTokens {
			return result[left].TotalTokens > result[right].TotalTokens
		}
		if result[left].Provider != result[right].Provider {
			return result[left].Provider < result[right].Provider
		}
		return result[left].SessionID < result[right].SessionID
	})
	return result
}

func Sort(records []Record) {
	sort.Slice(records, func(left, right int) bool {
		return records[left].OccurredAt().Before(records[right].OccurredAt())
	})
}
