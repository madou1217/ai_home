package managementops

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"errors"
	"strings"
	"sync/atomic"
	"time"
)

var lastRevisionEpochSeed atomic.Int64

func nextRevisionEpochSeed(oldEpoch int64) int64 {
	var buf [8]byte
	var randLow int64
	if _, err := rand.Read(buf[:]); err == nil {
		randLow = int64(binary.LittleEndian.Uint64(buf[:]) & ((1 << 20) - 1))
	}
	ms := time.Now().UnixMilli()
	if ms < 0 {
		ms = 0
	}
	candidate := (ms << 20) | randLow
	if candidate <= 1 {
		candidate = 2
	}
	for {
		prev := lastRevisionEpochSeed.Load()
		adj := candidate
		if adj <= oldEpoch {
			adj = oldEpoch + 1
		}
		if adj <= prev {
			adj = prev + 1
		}
		if lastRevisionEpochSeed.CompareAndSwap(prev, adj) {
			return adj
		}
	}
}

// UsageProjectionRevision captures a store-scoped consistency token for usage
// projection, stats, and dashboard caches across inserts, updates, deletes,
// fork state, session metadata, pricing mutations, trigger repairs, and
// cross-store writes. When Cacheable is false (e.g. missing/invalid trigger or
// read-only unmigrated DB), callers MUST fail closed and bypass caches.
type UsageProjectionRevision struct {
	Cacheable     bool
	TriggerBacked bool
	MemEpoch      uint64
	DBEpoch       int64
	GlobalRev     int64
	RecordsRev    int64
	PromptsRev    int64
	SessionsRev   int64
	FileStateRev  int64
	PricingRev    int64
}

func sameDataRevision(a, b UsageProjectionRevision) bool {
	return a.Cacheable &&
		b.Cacheable &&
		a.TriggerBacked &&
		b.TriggerBacked &&
		a.MemEpoch == b.MemEpoch &&
		a.DBEpoch == b.DBEpoch &&
		a.RecordsRev == b.RecordsRev &&
		a.PromptsRev == b.PromptsRev &&
		a.FileStateRev == b.FileStateRev &&
		a.PricingRev == b.PricingRev
}

type sqlQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// initProjectionRevisionSchema dynamically initializes persistent revision
// tracking once database tables are ready without relying on numeric schema
// version constants or gates. When neither 'accounts' nor
// 'model_usage_projection_revision' exists yet (e.g. write-only CLI callers
// opening UsageStore before sqliteaccount.Open), trigger creation is deferred
// until first projection/dashboard read.
func (s *UsageStore) initProjectionRevisionSchema(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var ready int
	if err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM sqlite_master
		WHERE type = 'table' AND name IN ('accounts', 'model_usage_projection_revision')
		LIMIT 1`).Scan(&ready); err != nil || ready == 0 {
		return
	}
	s.ensureProjectionRevisionSchemaOnce(ctx)
}

func (s *UsageStore) ensureProjectionRevisionSchemaOnce(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return
	}
	if s.projCache != nil && !s.projCache.tryBeginRevisionInit(ctx, s.now) {
		return
	}
	finished := false
	defer func() {
		if !finished && s.projCache != nil {
			s.projCache.finishRevisionInitResult(errors.New("revision_init_aborted"), ctx.Err(), s.now(), false)
		}
	}()
	s.writeMu.Lock()
	repaired, err := ensureProjectionRevisionSchemaWithRepair(ctx, s.db)
	s.writeMu.Unlock()
	finished = true
	if s.projCache != nil {
		s.projCache.finishRevisionInitResult(err, ctx.Err(), s.now(), repaired)
	}
}

// ProjectionRevision returns the current store-scoped DB + in-memory revision.
// If any required trigger or counter row is missing or invalid (for example, on
// a read-only unmigrated DB or after external DROP TRIGGER), it fails closed with
// Cacheable=false, invalidates stale local caches, and performs zero userdata scans.
func (s *UsageStore) ProjectionRevision(ctx context.Context) (UsageProjectionRevision, error) {
	if s == nil || s.db == nil {
		return UsageProjectionRevision{}, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return UsageProjectionRevision{}, err
	}
	s.ensureProjectionRevisionSchemaOnce(ctx)
	if err := ctx.Err(); err != nil {
		return UsageProjectionRevision{}, err
	}

	conn, err := s.db.Conn(ctx)
	if err != nil {
		return UsageProjectionRevision{}, err
	}
	defer func() { _ = conn.Close() }()

	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return UsageProjectionRevision{}, err
	}
	defer snap.close()

	return s.readProjectionRevisionQuerier(ctx, conn)
}

func isSQLiteMissingRevisionSchema(err error) bool {
	if err == nil {
		return false
	}
	if isSQLiteMissingTable(err) {
		return true
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such column")
}

func (s *UsageStore) readProjectionRevisionQuerier(ctx context.Context, q sqlQuerier) (UsageProjectionRevision, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return UsageProjectionRevision{}, err
	}
	var rev UsageProjectionRevision
	err := q.QueryRowContext(ctx, `
		SELECT db_epoch, rev, records_rev, prompts_rev, sessions_rev, file_state_rev, pricing_rev
		FROM model_usage_projection_revision
		WHERE id = 1`).Scan(
		&rev.DBEpoch,
		&rev.GlobalRev,
		&rev.RecordsRev,
		&rev.PromptsRev,
		&rev.SessionsRev,
		&rev.FileStateRev,
		&rev.PricingRev,
	)
	if err != nil {
		if isSQLiteMissingRevisionSchema(err) || errors.Is(err, sql.ErrNoRows) {
			if s.projCache != nil {
				s.projCache.onRevisionGapDetected()
			}
			// Fail closed for caching: never scan userdata tables on unmigrated/read-only DBs.
			return UsageProjectionRevision{
				Cacheable:     false,
				TriggerBacked: false,
				MemEpoch:      s.currentMemEpoch(),
			}, nil
		}
		return UsageProjectionRevision{}, err
	}

	allValid, _, _, inspErr := inspectProjectionTriggersQuerier(ctx, q)
	if inspErr != nil {
		return UsageProjectionRevision{}, inspErr
	}
	if !allValid || rev.DBEpoch <= 0 {
		if s.projCache != nil {
			s.projCache.onRevisionGapDetected()
		}
		return UsageProjectionRevision{
			Cacheable:     false,
			TriggerBacked: false,
			MemEpoch:      s.currentMemEpoch(),
		}, nil
	}

	rev.Cacheable = true
	rev.TriggerBacked = true
	rev.MemEpoch = s.currentMemEpoch()
	return rev, nil
}
