// Package remotesessions is the durable ledger of connector agent launches.
// It is the canonical identity a remote execution is observed and stopped by;
// usage attribution stays on the existing account/gateway path.
package remotesessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

var ErrInvalidDependencies = errors.New("remote session dependencies are invalid")

const (
	key           = "remote:execution-sessions"
	maxRecords    = 100
	maxLabelRunes = 160

	StatusRunning = "running"
	StatusExited  = "exited"
	StatusStopped = "stopped"
	StatusUnknown = "unknown"
)

// Session is one connector agent launch. It never contains tokens or paths.
type Session struct {
	ID            string  `json:"id"`
	WorkspaceID   string  `json:"workspaceId"`
	ConnectorID   string  `json:"connectorId,omitempty"`
	Agent         string  `json:"agent"`
	Account       string  `json:"account,omitempty"`
	Model         string  `json:"model,omitempty"`
	SessionKey    string  `json:"sessionKey"`
	TermID        string  `json:"termId,omitempty"`
	Status        string  `json:"status"`
	ToolExpiresAt int64   `json:"toolExpiresAt,omitempty"`
	CreatedAt     int64   `json:"createdAt"`
	UpdatedAt     int64   `json:"updatedAt"`
	StoppedAt     int64   `json:"stoppedAt,omitempty"`
	Events        []Event `json:"events,omitempty"`
}

// Event is one lifecycle fact about a remote execution session.
type Event struct {
	At     int64  `json:"at"`
	Type   string `json:"type"`
	Detail string `json:"detail,omitempty"`
}

type Store struct {
	databasePath string
	now          func() time.Time
}

func NewStore(databasePath string) (*Store, error) {
	databasePath = strings.TrimSpace(databasePath)
	if databasePath == "" {
		return nil, errors.New("remote session database path is required")
	}
	return &Store{databasePath: databasePath, now: time.Now}, nil
}

// Record upserts by session key: reusing a terminal updates the existing
// session instead of inventing a second identity.
func (store *Store) Record(ctx context.Context, session Session) (Session, error) {
	if store == nil {
		return Session{}, errors.New("remote session store is nil")
	}
	if strings.TrimSpace(session.SessionKey) == "" || strings.TrimSpace(session.WorkspaceID) == "" {
		return Session{}, errors.New("session key and workspace are required")
	}
	now := store.now().UnixMilli()
	var saved Session
	err := store.update(ctx, func(state *persistedState) error {
		for index := range state.Sessions {
			if state.Sessions[index].SessionKey != session.SessionKey {
				continue
			}
			record := &state.Sessions[index]
			record.TermID = firstNonEmpty(session.TermID, record.TermID)
			record.Agent = firstNonEmpty(session.Agent, record.Agent)
			record.Account = firstNonEmpty(session.Account, record.Account)
			record.Model = firstNonEmpty(session.Model, record.Model)
			record.Status = StatusRunning
			record.StoppedAt = 0
			record.UpdatedAt = now
			record.Events = appendEvent(record.Events, "started", "")
			if session.ToolExpiresAt > 0 {
				record.ToolExpiresAt = session.ToolExpiresAt
			}
			saved = *record
			return nil
		}
		record := session
		record.ID = newSessionID()
		record.SessionKey = strings.TrimSpace(record.SessionKey)
		record.WorkspaceID = strings.TrimSpace(record.WorkspaceID)
		record.ConnectorID = sanitize(record.ConnectorID, maxLabelRunes)
		record.Agent = sanitize(record.Agent, 32)
		record.Account = sanitize(record.Account, maxLabelRunes)
		record.Model = sanitize(record.Model, maxLabelRunes)
		record.Status = StatusRunning
		record.CreatedAt = now
		record.UpdatedAt = now
		record.StoppedAt = 0
		record.Events = []Event{{At: now, Type: "started"}}
		state.Sessions = append(state.Sessions, record)
		if len(state.Sessions) > maxRecords {
			state.Sessions = state.Sessions[len(state.Sessions)-maxRecords:]
		}
		saved = record
		return nil
	})
	return saved, err
}

func (store *Store) List(ctx context.Context) ([]Session, error) {
	state, err := store.load(ctx)
	if err != nil {
		return nil, err
	}
	records := append([]Session(nil), state.Sessions...)
	sort.Slice(records, func(left, right int) bool {
		return records[left].CreatedAt > records[right].CreatedAt
	})
	return records, nil
}

func (store *Store) Find(ctx context.Context, id string) (Session, bool, error) {
	state, err := store.load(ctx)
	if err != nil {
		return Session{}, false, err
	}
	for _, record := range state.Sessions {
		if record.ID == strings.TrimSpace(id) {
			return record, true, nil
		}
	}
	return Session{}, false, nil
}

// Close marks one session stopped. The terminal kill is the caller's job so the
// store stays free of terminal-session dependencies.
func (store *Store) Close(ctx context.Context, id string) (Session, error) {
	now := store.now().UnixMilli()
	var saved Session
	found := false
	err := store.update(ctx, func(state *persistedState) error {
		for index := range state.Sessions {
			if state.Sessions[index].ID != strings.TrimSpace(id) {
				continue
			}
			record := &state.Sessions[index]
			if record.Status != StatusStopped {
				record.Status = StatusStopped
				record.StoppedAt = now
				record.Events = appendEvent(record.Events, StatusStopped, "")
			}
			record.UpdatedAt = now
			saved = *record
			found = true
			return nil
		}
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	if !found {
		return Session{}, errors.New("remote execution session not found")
	}
	return saved, nil
}

type persistedState struct {
	Sessions []Session `json:"sessions"`
}

// MarkExited records an observed natural exit exactly once.
func (store *Store) MarkExited(ctx context.Context, id string) error {
	now := store.now().UnixMilli()
	return store.update(ctx, func(state *persistedState) error {
		for index := range state.Sessions {
			record := &state.Sessions[index]
			if record.ID != strings.TrimSpace(id) || record.Status == StatusStopped {
				continue
			}
			if lastEventType(record.Events) == StatusExited {
				return nil
			}
			record.Status = StatusExited
			record.UpdatedAt = now
			record.Events = appendEvent(record.Events, StatusExited, "")
		}
		return nil
	})
}

func appendEvent(events []Event, eventType, detail string) []Event {
	events = append(events, Event{At: time.Now().UnixMilli(), Type: eventType, Detail: detail})
	if len(events) > 20 {
		events = events[len(events)-20:]
	}
	return events
}

func lastEventType(events []Event) string {
	if len(events) == 0 {
		return ""
	}
	return events[len(events)-1].Type
}

func (store *Store) load(ctx context.Context) (persistedState, error) {
	raw, found, err := appstate.ReadKV(ctx, store.databasePath, key)
	if err != nil {
		return persistedState{}, err
	}
	state := persistedState{}
	if found && strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return persistedState{}, err
		}
	}
	return state, nil
}

func (store *Store) update(ctx context.Context, mutate func(*persistedState) error) error {
	return appstate.UpdateKV(ctx, store.databasePath, key, func(current string, found bool) (string, error) {
		state := persistedState{}
		if found && strings.TrimSpace(current) != "" {
			if err := json.Unmarshal([]byte(current), &state); err != nil {
				return "", err
			}
		}
		if err := mutate(&state); err != nil {
			return "", err
		}
		encoded, err := json.Marshal(state)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
}

func newSessionID() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return "rx-000000000000000000"
	}
	return "rx-" + hex.EncodeToString(buffer)
}

func sanitize(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > limit {
		return string([]rune(value)[:limit])
	}
	return value
}

func firstNonEmpty(next, current string) string {
	if strings.TrimSpace(next) != "" {
		return strings.TrimSpace(next)
	}
	return current
}
