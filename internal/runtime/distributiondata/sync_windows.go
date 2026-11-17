//go:build windows

package distributiondata

// syncDir is deliberately a no-op ONLY for this package's private preparation
// directories: Windows directory handles do not support os.File.Sync. Every
// original, SQLite backup, fingerprint and report file is individually Sync'd.
// The result is PREPARED, never PUBLISHED, and no active home is exchanged here.
// The installer owns publication durability and must use its write-through file
// exchange (MoveFileEx with MOVEFILE_WRITE_THROUGH), journal and rollback. This
// is not a general-purpose durable-directory helper for live publication.
func syncDir(_ string) error { return nil }
