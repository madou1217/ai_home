package peer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/accountmaintenance"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

// ClaimLease identifies one delivery generation. ClaimedAt starts when pending
// is claimed, independently of the pending file's age. Tokens are never reused.
type ClaimLease struct {
	Token      string `json:"token"`
	Generation int64  `json:"generation"`
	ClaimedAt  int64  `json:"claimedAt"`
}

var ErrClaimLost = errors.New("peer_claim_lost")

// lockRecords reuses the existing account-maintenance coordination lock with
// Node claim-lease.js. Its ordinary SHARED leases coexist with our short
// RESERVED writer lock. We never commit or change its schema/data, and never
// open a second peer database. The OS releases ownership on process exit.
func (s *DispatchStore) lockRecords() (func(), error) {
	if err := s.EnsureLayout(); err != nil {
		return nil, err
	}
	// Reuse initialization, path validation, gate handling and SHARED lifetime
	// protection. A separate RESERVED connection excludes other peer writers
	// without upgrading/releasing the host's existing account SHARED lease.
	shared, err := accountmaintenance.Acquire(context.Background(), s.aiHomeDir)
	if err != nil {
		return nil, err
	}
	file := filepath.Join(s.aiHomeDir, "run", "maintenance", "access.sqlite")
	// Never open/close a separate descriptor for this inode: POSIX closes
	// can release another SQLite connection's process-wide file locks.
	database, err := sql.Open("sqlite", sqlitefile.URL(file).String())
	if err != nil {
		shared.Close()
		return nil, err
	}
	database.SetMaxOpenConns(1)
	closeWithError := func(err error) (func(), error) {
		_ = database.Close()
		shared.Close()
		return nil, fmt.Errorf("peer_claim_lease_unavailable: %w", err)
	}
	if _, err := database.Exec("PRAGMA busy_timeout = 1000"); err != nil {
		return closeWithError(err)
	}
	if _, err := database.Exec("BEGIN IMMEDIATE"); err != nil {
		return closeWithError(err)
	}
	return func() {
		_, _ = database.Exec("ROLLBACK")
		_ = database.Close()
		shared.Close()
	}, nil
}

func sameClaim(left, right *ClaimLease) bool {
	return left != nil && right != nil && left.Token != "" &&
		left.Token == right.Token && left.Generation > 0 &&
		left.Generation == right.Generation && left.ClaimedAt == right.ClaimedAt
}

// ownedRecord must run under lockRecords: checking and writing are one critical
// section, so recovery cannot replace a generation between them.
func (s *DispatchStore) ownedRecord(rec *Record) (*Record, error) {
	current, err := s.readStoredRecord("inflight", rec.ID)
	if errors.Is(err, os.ErrNotExist) || (err == nil && !sameClaim(rec.Claim, current.Claim)) {
		return nil, fmt.Errorf("%w: %s", ErrClaimLost, rec.ID)
	}
	return current, err
}
