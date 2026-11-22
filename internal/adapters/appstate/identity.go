package appstate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrServerIdentityUnavailable = errors.New("server identity is unavailable")

type serverIdentity struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt,omitempty"`
}

// ReadServerIdentity returns the stable Server identity without creating one.
func ReadServerIdentity(ctx context.Context, databasePath string) (string, bool, error) {
	raw, found, err := ReadKV(ctx, databasePath, KeyServerIdentity)
	if err != nil || !found || len(raw) > 4096 {
		return "", false, err
	}
	var identity serverIdentity
	if err := json.Unmarshal([]byte(raw), &identity); err != nil {
		return "", false, nil
	}
	identity.ID = strings.TrimSpace(identity.ID)
	if identity.ID == "" {
		return "", false, nil
	}
	return identity.ID, true, nil
}

// EnsureServerIdentity creates the stable Server identity once. It preserves a
// valid existing value and repairs an invalid one instead of inventing a new
// identity on every start.
func EnsureServerIdentity(ctx context.Context, databasePath string) (string, error) {
	if strings.TrimSpace(databasePath) == "" {
		return "", ErrServerIdentityUnavailable
	}
	identity := ""
	err := UpdateKV(ctx, databasePath, KeyServerIdentity, func(current string, found bool) (string, error) {
		if found && strings.TrimSpace(current) != "" {
			var existing serverIdentity
			if json.Unmarshal([]byte(current), &existing) == nil && strings.TrimSpace(existing.ID) != "" {
				identity = strings.TrimSpace(existing.ID)
				return current, nil
			}
		}
		buffer := make([]byte, 16)
		if _, err := rand.Read(buffer); err != nil {
			return "", err
		}
		identity = "srv-" + hex.EncodeToString(buffer)
		encoded, err := json.Marshal(serverIdentity{ID: identity, CreatedAt: time.Now().UnixMilli()})
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
	if err != nil {
		return "", err
	}
	if identity == "" {
		return "", ErrServerIdentityUnavailable
	}
	return identity, nil
}
