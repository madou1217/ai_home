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
	TotalCalls            uint64
	TotalSessions         uint64
	InputTokens           uint64
	OutputTokens          uint64
	CacheReadInputTokens  uint64
	CacheWriteInputTokens uint64
	ReasoningOutputTokens uint64
	TotalTokens           uint64
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

func Sort(records []Record) {
	sort.Slice(records, func(left, right int) bool {
		return records[left].OccurredAt().Before(records[right].OccurredAt())
	})
}
