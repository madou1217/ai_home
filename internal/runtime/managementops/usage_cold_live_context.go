package managementops

import (
	"math"
	"sort"
)

// collectColdLiveContext validates in-memory rollup attributions within
// [attrFrom, attrTo] and rollupRanges, verifies disjointness against live
// attributions (matching mergeDisjointAttributions), and publishes an immutable
// request-local liveCanonicalContext ready for read-only sharing across shard
// workers without intermediate slice copies or sorting.
func collectColdLiveContext(
	byHour map[int64]*rollupHourBuild,
	sortedHours []int64,
	rollupRanges []hourRange,
	attrFrom, attrTo int64,
	live []usageAttribution,
	forksByHash map[string]forkDescriptor,
) (liveCanonicalContext, bool) {
	byScanner := make(map[int64]usageAttribution)
	byProxy := make(map[int64]struct{})
	for _, rr := range rollupRanges {
		idx := sort.Search(len(sortedHours), func(i int) bool { return sortedHours[i] >= rr.StartHour })
		for i := idx; i < len(sortedHours) && sortedHours[i] < rr.EndHour; i++ {
			for _, a := range byHour[sortedHours[i]].attrs {
				if a.ScannerTimestampMS < attrFrom || a.ScannerTimestampMS > attrTo ||
					a.ProxyTimestampMS < attrFrom || a.ProxyTimestampMS > attrTo ||
					!isHourInRanges(hourFloorMS(a.ScannerTimestampMS), rollupRanges) ||
					!isHourInRanges(hourFloorMS(a.ProxyTimestampMS), rollupRanges) {
					return liveCanonicalContext{}, false
				}
				if prev, dupS := byScanner[a.ScannerID]; dupS {
					if prev.ProxyID != a.ProxyID || prev.ScannerTimestampMS != a.ScannerTimestampMS ||
						prev.ProxyTimestampMS != a.ProxyTimestampMS || prev.Model != a.Model ||
						prev.AccountProvider != a.AccountProvider || prev.AccountRef != a.AccountRef ||
						math.Float64bits(prev.CostUSD) != math.Float64bits(a.CostUSD) {
						return liveCanonicalContext{}, false
					}
					continue
				}
				// Exact duplicate ScannerIDs already continued above (and mismatched ones
				// returned false), so any existing ProxyID here must belong to a different ScannerID.
				if _, dupP := byProxy[a.ProxyID]; dupP {
					return liveCanonicalContext{}, false
				}
				byScanner[a.ScannerID] = a
				byProxy[a.ProxyID] = struct{}{}
			}
		}
	}
	for _, a := range live {
		if _, exists := byScanner[a.ScannerID]; exists {
			return liveCanonicalContext{}, false
		}
		if _, exists := byProxy[a.ProxyID]; exists {
			return liveCanonicalContext{}, false
		}
		byScanner[a.ScannerID] = a
		byProxy[a.ProxyID] = struct{}{}
	}
	return liveCanonicalContext{
		forksByHash:   forksByHash,
		attrByScanner: byScanner,
		matchedProxy:  byProxy,
		recordHW:      math.MaxInt64,
		promptHW:      math.MaxInt64,
	}, true
}
