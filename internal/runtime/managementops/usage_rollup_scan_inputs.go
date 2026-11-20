package managementops

import (
	"context"
	"database/sql"
)

// rollupScanInputs holds immutable per-snapshot metadata, fork lookup table,
// and strict pricing snapshot prepared once for a caller's open read snapshot.
// All maps and snapshots are read-only and must not outlive the caller's snapshot.
type rollupScanInputs struct {
	snapRev             int64
	snapForkRev         int64
	snapPricingRev      int64
	forkDigest          int64
	customPricingDigest int64
	forksByHash         map[string]forkDescriptor
	pricingSnap         pricingResolverSnapshot
}

// prepareRollupScanInputsConn builds immutable rollupScanInputs from an already-verified
// rollupCapabilityReport on the caller's open read snapshot connection.
func (s *UsageStore) prepareRollupScanInputsConn(
	ctx context.Context,
	conn *sql.Conn,
	capReport rollupCapabilityReport,
	pricingCache *rollupSyncPricingCache,
) (rollupScanInputs, error) {
	if s == nil || conn == nil {
		return rollupScanInputs{}, ErrUsageUnavailable
	}
	if !capReport.allReady {
		return rollupScanInputs{}, errRollupCapabilitiesNotReady
	}
	meta := capReport.meta

	forks, fDigest, err := s.getCachedForkDescriptorsConn(ctx, conn, meta.forkRev)
	if err != nil {
		return rollupScanInputs{}, err
	}
	forksByHash := make(map[string]forkDescriptor, len(forks))
	for _, f := range forks {
		forksByHash[f.SourceHash] = f
	}

	// Reuse only within this serial sync/worker, after same-snapshot capability
	// and both persistent DATA pricing revisions have been verified.
	pricingSnap, digest, err := pricingCache.loadConn(ctx, s, conn, capReport)
	if err != nil {
		return rollupScanInputs{}, err
	}

	return rollupScanInputs{
		snapRev:             meta.changeRev,
		snapForkRev:         meta.forkRev,
		snapPricingRev:      meta.pricingRev,
		forkDigest:          fDigest,
		customPricingDigest: digest,
		forksByHash:         forksByHash,
		pricingSnap:         pricingSnap,
	}, nil
}
