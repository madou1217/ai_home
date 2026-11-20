package managementops

// rollupScanRetainedRowLimit caps only the per-slice backing capacity retained
// between chunks on a single cold worker; it never truncates queried rows.
const rollupScanRetainedRowLimit = 32768

// rollupScanScratch holds worker-local reusable observationRow slices for serial
// cold chunks on one worker goroutine. Never shared across workers or requests.
type rollupScanScratch struct {
	proxies    []observationRow
	scanners   []observationRow
	targetRows []observationRow
}

// retainScanRows drops oversized backing arrays and clears the full retained
// capacity (including any tail written by slice extensions inside closure)
// before resetting length to zero.
func retainScanRows(rows []observationRow) []observationRow {
	if cap(rows) > rollupScanRetainedRowLimit {
		return nil
	}
	clear(rows[:cap(rows)])
	return rows[:0]
}
