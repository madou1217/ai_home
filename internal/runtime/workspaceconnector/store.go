// Package workspaceconnector owns the Server-side enrollment, workspace identity
// and live Workspace Connector sessions.
//
// It deliberately does not know about HTTP, WebSocket or provider CLIs. The
// transport adapters call this package; the provider supervisor will later use
// the same Hub to reach the local workspace.
package workspaceconnector

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	stateVersion = 1

	DefaultEnrollmentTTL = 10 * time.Minute
	MaxEnrollmentTTL     = time.Hour
	DefaultToolTokenTTL  = 12 * time.Hour
	MaxToolTokenTTL      = 7 * 24 * time.Hour
	maxEnrollments       = 64
	maxWorkspaces        = 64
	maxToolTokens        = 64
	enrollmentRetention  = 24 * time.Hour
	touchPersistInterval = 20 * time.Second

	maxLabelRunes     = 64
	maxRootLabelRunes = 160
	maxPlatformRunes  = 32
)

// Store persists non-secret connector identity in aih.db app_kv. Plaintext
// enrollment codes and session tokens are never written.
type Store struct {
	databasePath string
	now          func() time.Time

	touchMu   sync.Mutex
	lastTouch map[string]time.Time
}

// Enrollment is returned exactly once, when the code is created.
type Enrollment struct {
	ID           string                       `json:"id"`
	Code         string                       `json:"code,omitempty"`
	Label        string                       `json:"label"`
	ExpiresAt    int64                        `json:"expiresAt"`
	Capabilities remoteconnector.Capabilities `json:"capabilities"`
}

// Workspace is the durable, non-secret identity of an enrolled local root.
type Workspace struct {
	ID           string                       `json:"id"`
	ConnectorID  string                       `json:"connectorId"`
	Label        string                       `json:"label"`
	RootLabel    string                       `json:"rootLabel,omitempty"`
	Platform     string                       `json:"platform,omitempty"`
	Capabilities remoteconnector.Capabilities `json:"capabilities"`
	CreatedAt    int64                        `json:"createdAt"`
	LastSeenAt   int64                        `json:"lastSeenAt,omitempty"`
	RevokedAt    int64                        `json:"revokedAt,omitempty"`
}

func (workspace Workspace) Revoked() bool { return workspace.RevokedAt > 0 }

type enrollmentRecord struct {
	ID           string                       `json:"id"`
	CodeHash     string                       `json:"codeHash"`
	Label        string                       `json:"label"`
	Capabilities remoteconnector.Capabilities `json:"capabilities"`
	CreatedAt    int64                        `json:"createdAt"`
	ExpiresAt    int64                        `json:"expiresAt"`
	UsedAt       int64                        `json:"usedAt,omitempty"`
	WorkspaceID  string                       `json:"workspaceId,omitempty"`
}

type workspaceRecord struct {
	ID           string                       `json:"id"`
	ConnectorID  string                       `json:"connectorId"`
	Label        string                       `json:"label"`
	RootLabel    string                       `json:"rootLabel,omitempty"`
	Platform     string                       `json:"platform,omitempty"`
	Capabilities remoteconnector.Capabilities `json:"capabilities"`
	TokenHash    string                       `json:"tokenHash"`
	CreatedAt    int64                        `json:"createdAt"`
	LastSeenAt   int64                        `json:"lastSeenAt,omitempty"`
	RevokedAt    int64                        `json:"revokedAt,omitempty"`
}

// toolTokenRecord is a workspace-scoped capability for a provider tool bridge.
// Only the digest is persisted; the plaintext token lives in the launch context
// file consumed by the provider child process.
type toolTokenRecord struct {
	TokenHash   string `json:"tokenHash"`
	WorkspaceID string `json:"workspaceId"`
	CreatedAt   int64  `json:"createdAt"`
	ExpiresAt   int64  `json:"expiresAt"`
}

type persistedState struct {
	Version     int                `json:"version"`
	Enrollments []enrollmentRecord `json:"enrollments"`
	Workspaces  []workspaceRecord  `json:"workspaces"`
	ToolTokens  []toolTokenRecord  `json:"toolTokens,omitempty"`
}

func NewStore(databasePath string) (*Store, error) {
	databasePath = strings.TrimSpace(databasePath)
	if databasePath == "" {
		return nil, errors.New("workspace connector database path is required")
	}
	return &Store{
		databasePath: databasePath,
		now:          time.Now,
		lastTouch:    make(map[string]time.Time),
	}, nil
}

// CreateEnrollment issues a one-time code. The plaintext code exists only in
// this return value; the persisted state stores its SHA-256 digest.
func (store *Store) CreateEnrollment(ctx context.Context, label string, ttl time.Duration) (Enrollment, error) {
	if store == nil {
		return Enrollment{}, errors.New("workspace connector store is nil")
	}
	if ttl <= 0 {
		ttl = DefaultEnrollmentTTL
	}
	if ttl > MaxEnrollmentTTL {
		ttl = MaxEnrollmentTTL
	}
	label = sanitizeText(label, "workspace", maxLabelRunes)
	code, err := randomToken()
	if err != nil {
		return Enrollment{}, err
	}
	now := store.now()
	record := enrollmentRecord{
		ID:           newID("en-"),
		CodeHash:     hashToken(code),
		Label:        label,
		Capabilities: defaultCapabilities(),
		CreatedAt:    now.UnixMilli(),
		ExpiresAt:    now.Add(ttl).UnixMilli(),
	}
	err = store.update(ctx, now, func(state *persistedState) error {
		if len(state.Enrollments) >= maxEnrollments {
			return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceLimit, "too many pending enrollments")
		}
		state.Enrollments = append(state.Enrollments, record)
		return nil
	})
	if err != nil {
		return Enrollment{}, err
	}
	return Enrollment{
		ID: record.ID, Code: code, Label: record.Label,
		ExpiresAt: record.ExpiresAt, Capabilities: record.Capabilities,
	}, nil
}

// ClaimEnrollment consumes a one-time code and creates the durable workspace
// identity. The returned session token is the only credential the connector
// keeps; the Server persists only its digest.
func (store *Store) ClaimEnrollment(ctx context.Context, code string, hello remoteconnector.Hello) (Workspace, string, error) {
	if store == nil {
		return Workspace{}, "", errors.New("workspace connector store is nil")
	}
	codeHash := hashToken(strings.TrimSpace(code))
	if codeHash == "" {
		return Workspace{}, "", remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "enrollment code is missing")
	}
	token, err := randomToken()
	if err != nil {
		return Workspace{}, "", err
	}
	now := store.now()
	var claimed Workspace
	err = store.update(ctx, now, func(state *persistedState) error {
		index := -1
		for position := range state.Enrollments {
			if equalHash(state.Enrollments[position].CodeHash, codeHash) {
				index = position
				break
			}
		}
		if index < 0 {
			return remoteconnector.NewProtocolError(remoteconnector.CodeEnrollmentNotFound, "enrollment code does not exist")
		}
		enrollment := &state.Enrollments[index]
		switch {
		case enrollment.UsedAt > 0:
			return remoteconnector.NewProtocolError(remoteconnector.CodeEnrollmentUsed, "enrollment code was already used")
		case enrollment.ExpiresAt > 0 && enrollment.ExpiresAt <= now.UnixMilli():
			return remoteconnector.NewProtocolError(remoteconnector.CodeEnrollmentExpired, "enrollment code has expired")
		}
		if len(state.Workspaces) >= maxWorkspaces {
			return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceLimit, "workspace limit reached")
		}
		capabilities := remoteconnector.IntersectCapabilities(enrollment.Capabilities, hello.Capabilities)
		if len(capabilities.NamesOrDerived()) == 0 {
			return remoteconnector.NewProtocolError(remoteconnector.CodeCapabilityNotAllowed, "connector declared no granted capability")
		}
		record := workspaceRecord{
			ID:           newID("wc-"),
			ConnectorID:  newID("cn-"),
			Label:        sanitizeText(enrollment.Label, "workspace", maxLabelRunes),
			RootLabel:    sanitizeText(hello.RootLabel, "", maxRootLabelRunes),
			Platform:     sanitizeText(hello.Platform, "", maxPlatformRunes),
			Capabilities: capabilities,
			TokenHash:    hashToken(token),
			CreatedAt:    now.UnixMilli(),
			LastSeenAt:   now.UnixMilli(),
		}
		state.Workspaces = append(state.Workspaces, record)
		enrollment.UsedAt = now.UnixMilli()
		enrollment.WorkspaceID = record.ID
		claimed = workspaceView(record)
		return nil
	})
	if err != nil {
		return Workspace{}, "", err
	}
	return claimed, token, nil
}

// IssueToolToken creates a workspace-scoped token for a provider tool bridge.
// It cannot authenticate a connector WebSocket and is cleared on revocation.
func (store *Store) IssueToolToken(ctx context.Context, workspaceID string, ttl time.Duration) (string, int64, error) {
	if store == nil {
		return "", 0, errors.New("workspace connector store is nil")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return "", 0, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is required")
	}
	if ttl <= 0 {
		ttl = DefaultToolTokenTTL
	}
	if ttl > MaxToolTokenTTL {
		ttl = MaxToolTokenTTL
	}
	token, err := randomToken()
	if err != nil {
		return "", 0, err
	}
	now := store.now()
	expiresAt := now.Add(ttl).UnixMilli()
	err = store.update(ctx, now, func(state *persistedState) error {
		found := false
		for _, workspace := range state.Workspaces {
			if workspace.ID == workspaceID {
				if workspace.RevokedAt > 0 {
					return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
				}
				found = true
				break
			}
		}
		if !found {
			return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
		}
		state.ToolTokens = append(state.ToolTokens, toolTokenRecord{
			TokenHash: hashToken(token), WorkspaceID: workspaceID,
			CreatedAt: now.UnixMilli(), ExpiresAt: expiresAt,
		})
		if len(state.ToolTokens) > maxToolTokens {
			state.ToolTokens = state.ToolTokens[len(state.ToolTokens)-maxToolTokens:]
		}
		return nil
	})
	if err != nil {
		return "", 0, err
	}
	return token, expiresAt, nil
}

// AuthenticateToolToken validates a provider tool bridge token for a workspace.
// It never upgrades the token into connector-session or management rights.
func (store *Store) AuthenticateToolToken(ctx context.Context, workspaceID, token string) (Workspace, error) {
	if store == nil {
		return Workspace{}, errors.New("workspace connector store is nil")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	tokenHash := hashToken(strings.TrimSpace(token))
	if workspaceID == "" || tokenHash == "" {
		return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "tool token is missing")
	}
	state, err := store.load(ctx)
	if err != nil {
		return Workspace{}, err
	}
	now := store.now().UnixMilli()
	authorized := false
	for _, record := range state.ToolTokens {
		if record.WorkspaceID != workspaceID || !equalHash(record.TokenHash, tokenHash) {
			continue
		}
		if record.ExpiresAt > 0 && record.ExpiresAt <= now {
			return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "tool token has expired")
		}
		authorized = true
		break
	}
	if !authorized {
		return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "tool token is invalid")
	}
	for _, record := range state.Workspaces {
		if record.ID != workspaceID {
			continue
		}
		if record.RevokedAt > 0 {
			return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
		}
		return workspaceView(record), nil
	}
	return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
}

// Authenticate validates a reconnect token for one workspace.
func (store *Store) Authenticate(ctx context.Context, workspaceID, token string) (Workspace, error) {
	if store == nil {
		return Workspace{}, errors.New("workspace connector store is nil")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	tokenHash := hashToken(strings.TrimSpace(token))
	if workspaceID == "" || tokenHash == "" {
		return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "workspace or token is missing")
	}
	state, err := store.load(ctx)
	if err != nil {
		return Workspace{}, err
	}
	for _, record := range state.Workspaces {
		if record.ID != workspaceID {
			continue
		}
		if record.RevokedAt > 0 {
			return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceRevoked, "workspace enrollment was revoked")
		}
		if !equalHash(record.TokenHash, tokenHash) {
			return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidToken, "workspace token is invalid")
		}
		return workspaceView(record), nil
	}
	return Workspace{}, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
}

func (store *Store) List(ctx context.Context) ([]Workspace, error) {
	if store == nil {
		return nil, errors.New("workspace connector store is nil")
	}
	state, err := store.load(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Workspace, 0, len(state.Workspaces))
	for _, record := range state.Workspaces {
		result = append(result, workspaceView(record))
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].CreatedAt != result[right].CreatedAt {
			return result[left].CreatedAt > result[right].CreatedAt
		}
		return result[left].ID < result[right].ID
	})
	return result, nil
}

func (store *Store) Find(ctx context.Context, workspaceID string) (Workspace, bool, error) {
	if store == nil {
		return Workspace{}, false, errors.New("workspace connector store is nil")
	}
	state, err := store.load(ctx)
	if err != nil {
		return Workspace{}, false, err
	}
	for _, record := range state.Workspaces {
		if record.ID == strings.TrimSpace(workspaceID) {
			return workspaceView(record), true, nil
		}
	}
	return Workspace{}, false, nil
}

// Touch persists liveness at most once per touchPersistInterval. The Hub owns
// sub-second liveness; this value only survives a Server restart.
func (store *Store) Touch(ctx context.Context, workspaceID string) error {
	if store == nil {
		return errors.New("workspace connector store is nil")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil
	}
	store.touchMu.Lock()
	if last := store.lastTouch[workspaceID]; !last.IsZero() && store.now().Sub(last) < touchPersistInterval {
		store.touchMu.Unlock()
		return nil
	}
	store.lastTouch[workspaceID] = store.now()
	store.touchMu.Unlock()

	now := store.now()
	err := store.update(ctx, now, func(state *persistedState) error {
		for index := range state.Workspaces {
			if state.Workspaces[index].ID == workspaceID {
				if state.Workspaces[index].RevokedAt == 0 {
					state.Workspaces[index].LastSeenAt = now.UnixMilli()
				}
				return nil
			}
		}
		return nil
	})
	if err != nil {
		store.touchMu.Lock()
		delete(store.lastTouch, workspaceID)
		store.touchMu.Unlock()
	}
	return err
}

// Revoke disables the workspace and clears its token digest. Revocation is
// durable: a connector cannot silently re-authenticate with the old token.
func (store *Store) Revoke(ctx context.Context, workspaceID string) error {
	if store == nil {
		return errors.New("workspace connector store is nil")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is required")
	}
	now := store.now()
	return store.update(ctx, now, func(state *persistedState) error {
		for index := range state.Workspaces {
			if state.Workspaces[index].ID != workspaceID {
				continue
			}
			if state.Workspaces[index].RevokedAt == 0 {
				state.Workspaces[index].RevokedAt = now.UnixMilli()
			}
			state.Workspaces[index].TokenHash = ""
			state.Workspaces[index].LastSeenAt = now.UnixMilli()
			keptTokens := make([]toolTokenRecord, 0, len(state.ToolTokens))
			for _, token := range state.ToolTokens {
				if token.WorkspaceID != workspaceID {
					keptTokens = append(keptTokens, token)
				}
			}
			state.ToolTokens = keptTokens
			return nil
		}
		return remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "workspace is not enrolled")
	})
}

func (store *Store) load(ctx context.Context) (persistedState, error) {
	raw, found, err := appstate.ReadKV(ctx, store.databasePath, appstate.KeyWorkspaceConnectors)
	if err != nil {
		return persistedState{}, fmt.Errorf("read workspace connector state: %w", err)
	}
	state := persistedState{Version: stateVersion}
	if found && strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return persistedState{}, fmt.Errorf("decode workspace connector state: %w", err)
		}
	}
	state.normalize(store.now())
	return state, nil
}

func (store *Store) update(ctx context.Context, now time.Time, mutate func(*persistedState) error) error {
	return appstate.UpdateKV(ctx, store.databasePath, appstate.KeyWorkspaceConnectors, func(current string, found bool) (string, error) {
		state := persistedState{Version: stateVersion}
		if found && strings.TrimSpace(current) != "" {
			if err := json.Unmarshal([]byte(current), &state); err != nil {
				return "", fmt.Errorf("decode workspace connector state: %w", err)
			}
		}
		state.normalize(now)
		if err := mutate(&state); err != nil {
			return "", err
		}
		state.prune(now)
		encoded, err := json.Marshal(state)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
}

func (state *persistedState) normalize(now time.Time) {
	if state.Version <= 0 {
		state.Version = stateVersion
	}
	if state.Enrollments == nil {
		state.Enrollments = []enrollmentRecord{}
	}
	if state.Workspaces == nil {
		state.Workspaces = []workspaceRecord{}
	}
	if state.ToolTokens == nil {
		state.ToolTokens = []toolTokenRecord{}
	}
	for index := range state.Enrollments {
		state.Enrollments[index].Capabilities = remoteconnector.NormalizeCapabilities(state.Enrollments[index].Capabilities)
	}
	for index := range state.Workspaces {
		state.Workspaces[index].Capabilities = remoteconnector.NormalizeCapabilities(state.Workspaces[index].Capabilities)
	}
	state.prune(now)
}

func (state *persistedState) prune(now time.Time) {
	keptEnrollments := make([]enrollmentRecord, 0, len(state.Enrollments))
	for _, enrollment := range state.Enrollments {
		expired := enrollment.ExpiresAt > 0 && enrollment.ExpiresAt+enrollmentRetention.Milliseconds() <= now.UnixMilli()
		used := enrollment.UsedAt > 0 && enrollment.UsedAt+enrollmentRetention.Milliseconds() <= now.UnixMilli()
		if expired || used {
			continue
		}
		keptEnrollments = append(keptEnrollments, enrollment)
	}
	state.Enrollments = keptEnrollments
	keptTokens := make([]toolTokenRecord, 0, len(state.ToolTokens))
	for _, token := range state.ToolTokens {
		if token.ExpiresAt > 0 && token.ExpiresAt <= now.UnixMilli() {
			continue
		}
		keptTokens = append(keptTokens, token)
	}
	state.ToolTokens = keptTokens
	if len(state.ToolTokens) > maxToolTokens {
		state.ToolTokens = state.ToolTokens[len(state.ToolTokens)-maxToolTokens:]
	}
}

func workspaceView(record workspaceRecord) Workspace {
	return Workspace{
		ID: record.ID, ConnectorID: record.ConnectorID, Label: record.Label,
		RootLabel: record.RootLabel, Platform: record.Platform,
		Capabilities: record.Capabilities, CreatedAt: record.CreatedAt,
		LastSeenAt: record.LastSeenAt, RevokedAt: record.RevokedAt,
	}
}

func defaultCapabilities() remoteconnector.Capabilities {
	return remoteconnector.NormalizeCapabilities(remoteconnector.Capabilities{
		ReadFile: true, WriteFile: true, ListDirectory: true, Search: true,
	})
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func newID(prefix string) string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return prefix + "000000000000000000"
	}
	return prefix + hex.EncodeToString(buffer)
}

func hashToken(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func equalHash(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func sanitizeText(value, fallback string, maxRunes int) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	lastSpace := false
	for _, character := range value {
		if unicode.IsControl(character) {
			continue
		}
		if unicode.IsSpace(character) {
			if !lastSpace && builder.Len() > 0 {
				builder.WriteByte(' ')
				lastSpace = true
			}
			continue
		}
		lastSpace = false
		builder.WriteRune(character)
		if utf8RuneCount(builder.String()) >= maxRunes {
			break
		}
	}
	result := strings.TrimSpace(builder.String())
	if result == "" {
		return fallback
	}
	return result
}

func utf8RuneCount(value string) int {
	count := 0
	for range value {
		count++
	}
	return count
}
