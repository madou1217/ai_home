package accountbrowser

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/accounts"
)

const (
	serverIDPrefix       = "server-"
	minServerIDLength    = len(serverIDPrefix) + 8
	maxServerIDLength    = 64
	maxProviderLength    = 64
	profileIDPrefix      = "browser_"
	profileIDHexLength   = 32
	profileIDTotalLength = len(profileIDPrefix) + profileIDHexLength
	profileHashDomain    = "accountbrowser:v1"
	profileSchemaVersion = 1
	maxMetadataBytes     = 64 * 1024
	maxTimestampMillis   = int64(253402300799999)
)

// Identity uniquely identifies an account-scoped browser profile across
// servers and providers using canonical stable identifiers only.
type Identity struct {
	ServerID   string `json:"serverId"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
}

// Validate checks that ServerID, Provider, and AccountRef are already in
// strict canonical form without silent trimming, lowercasing, or alias
// rewriting.
func (i Identity) Validate() error {
	if !isCanonicalServerID(i.ServerID) {
		return fmt.Errorf("invalid serverId: %w", ErrInvalidIdentity)
	}
	if !isCanonicalProvider(i.Provider) {
		return fmt.Errorf("invalid provider: %w", ErrInvalidIdentity)
	}
	if _, err := accounts.ParseAccountRef(i.AccountRef); err != nil {
		return fmt.Errorf("invalid accountRef: %w", ErrInvalidIdentity)
	}
	return nil
}

// Profile is the public, path-free and secret-free view of a durable account
// browser profile registration.
type Profile struct {
	ID         string `json:"id"`
	ServerID   string `json:"serverId"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	CreatedAt  int64  `json:"createdAt"`
}

type profileMetadata struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	ServerID      string `json:"serverId"`
	Provider      string `json:"provider"`
	AccountRef    string `json:"accountRef"`
	CreatedAt     int64  `json:"createdAt"`
}

// deriveProfileID computes a deterministic opaque profile identifier from the
// length-separated canonical (ServerID, Provider, AccountRef) triple.
func deriveProfileID(identity Identity) string {
	buf := make([]byte, 0, len(profileHashDomain)+len(identity.ServerID)+len(identity.Provider)+len(identity.AccountRef)+32)
	buf = append(buf, profileHashDomain...)
	buf = appendLengthPrefixed(buf, identity.ServerID)
	buf = appendLengthPrefixed(buf, identity.Provider)
	buf = appendLengthPrefixed(buf, identity.AccountRef)

	sum := sha256.Sum256(buf)
	out := make([]byte, profileIDTotalLength)
	copy(out, profileIDPrefix)
	hex.Encode(out[len(profileIDPrefix):], sum[:profileIDHexLength/2])
	return string(out)
}

func appendLengthPrefixed(dst []byte, value string) []byte {
	dst = append(dst, ':')
	dst = strconv.AppendInt(dst, int64(len(value)), 10)
	dst = append(dst, ':')
	dst = append(dst, value...)
	return dst
}

// isCanonicalServerID matches the canonical output of lib/server/server-identity.js
// normalizeServerId: ^server-[a-z0-9][a-z0-9-]{7,56}$ (total length 15..64).
func isCanonicalServerID(value string) bool {
	if len(value) < minServerIDLength || len(value) > maxServerIDLength {
		return false
	}
	if !strings.HasPrefix(value, serverIDPrefix) {
		return false
	}
	if !isLowerAlnum(value[len(serverIDPrefix)]) {
		return false
	}
	for idx := len(serverIDPrefix) + 1; idx < len(value); idx++ {
		c := value[idx]
		if !isLowerAlnum(c) && c != '-' {
			return false
		}
	}
	return true
}

// isCanonicalProvider validates a canonical lowercase provider identifier using
// letters, digits, '.', '_', and '-' (max 64 bytes), rejecting path-like forms.
func isCanonicalProvider(value string) bool {
	if len(value) == 0 || len(value) > maxProviderLength {
		return false
	}
	if !isLowerAlnum(value[0]) {
		return false
	}
	if strings.Contains(value, "..") {
		return false
	}
	for idx := 1; idx < len(value); idx++ {
		c := value[idx]
		if !isLowerAlnum(c) && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func isValidProfileID(value string) bool {
	if len(value) != profileIDTotalLength || !strings.HasPrefix(value, profileIDPrefix) {
		return false
	}
	for idx := len(profileIDPrefix); idx < len(value); idx++ {
		c := value[idx]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func isLowerAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}

func decodeAndValidateMetadata(raw []byte, identity Identity, expectedID string) (Profile, error) {
	if len(raw) == 0 || len(raw) > maxMetadataBytes {
		return Profile{}, fmt.Errorf("metadata size invalid: %w", ErrProfileCorrupt)
	}
	var meta profileMetadata
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&meta); err != nil {
		return Profile{}, fmt.Errorf("decode profile metadata: %w", ErrProfileCorrupt)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Profile{}, fmt.Errorf("trailing data in profile metadata: %w", ErrProfileCorrupt)
	}
	if meta.SchemaVersion != profileSchemaVersion {
		return Profile{}, fmt.Errorf("unsupported schemaVersion %d: %w", meta.SchemaVersion, ErrProfileCorrupt)
	}
	if !isValidProfileID(meta.ID) || meta.ID != expectedID {
		return Profile{}, fmt.Errorf("profile id mismatch: %w", ErrProfileCorrupt)
	}
	if meta.ServerID != identity.ServerID ||
		meta.Provider != identity.Provider ||
		meta.AccountRef != identity.AccountRef {
		return Profile{}, fmt.Errorf("profile identity mismatch: %w", ErrProfileCorrupt)
	}
	if meta.CreatedAt <= 0 || meta.CreatedAt > maxTimestampMillis {
		return Profile{}, fmt.Errorf("invalid createdAt timestamp: %w", ErrProfileCorrupt)
	}
	return Profile{
		ID:         meta.ID,
		ServerID:   meta.ServerID,
		Provider:   meta.Provider,
		AccountRef: meta.AccountRef,
		CreatedAt:  meta.CreatedAt,
	}, nil
}
