package distributiondata

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

var databaseNames = []string{businessdb.FileName, businessdb.LegacyFileName}
var sidecars = []string{"", "-wal", "-shm", "-journal"}

// VerifySource is read-only (including WAL/SHM); SQLite never opens Home. The
// installer must retain its writer exclusion after this check until publish.
func VerifySource(ctx context.Context, expected SourceFingerprint) error {
	if expected.Home == "" || len(expected.Files) != len(databaseNames)*len(sidecars) {
		return errors.New("distributiondata: missing source fingerprint")
	}
	actual, err := fingerprint(ctx, expected.Home, "")
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(expected, actual) {
		return errors.New("distributiondata: source_changed_since_preparation")
	}
	return nil
}

// capture is either empty (check only) or an exclusively owned directory. No
// SQLite connection, permission change, lock file, or checkpoint touches Home.
func fingerprint(ctx context.Context, home, capture string) (SourceFingerprint, error) {
	result := SourceFingerprint{Home: home}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	info, err := os.Lstat(home)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return result, errors.New("distributiondata: source Home must be a real directory")
		}
		result.HomeExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	var originals []os.FileInfo
	for _, name := range databaseNames {
		for _, suffix := range sidecars {
			entry, fileInfo, err := fingerprintFile(ctx, home, capture, name+suffix)
			if err != nil {
				return result, err
			}
			result.Files = append(result.Files, entry)
			if suffix == "" && fileInfo != nil {
				originals = append(originals, fileInfo)
			}
		}
	}
	if len(originals) == 2 && os.SameFile(originals[0], originals[1]) {
		return result, errors.New("distributiondata: canonical and legacy are the same file")
	}
	return result, nil
}

func fingerprintFile(ctx context.Context, home, capture, name string) (entry FileFingerprint, info os.FileInfo, resultErr error) {
	entry.Name = name
	path := filepath.Join(home, name)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return entry, nil, nil
	}
	if err != nil {
		return entry, nil, err
	}
	if !info.Mode().IsRegular() {
		return entry, info, fmt.Errorf("distributiondata: source must be a regular file: %s", name)
	}
	in, err := os.Open(path)
	if err != nil {
		return entry, info, err
	}
	defer func() { resultErr = errors.Join(resultErr, in.Close()) }()
	opened, err := in.Stat()
	if err != nil {
		return entry, info, err
	}
	if !os.SameFile(info, opened) {
		return entry, info, errors.New("distributiondata: source_changed_during_capture")
	}
	hash := sha256.New()
	var sink io.Writer = hash
	if capture != "" {
		out, err := os.OpenFile(filepath.Join(capture, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return entry, info, err
		}
		defer func() { resultErr = errors.Join(resultErr, out.Close()) }()
		sink = io.MultiWriter(hash, out)
		defer func() { resultErr = errors.Join(resultErr, out.Sync()) }()
	}
	if _, err := io.Copy(sink, contextReader{ctx, in}); err != nil {
		return entry, info, err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return entry, info, err
	}
	if !os.SameFile(info, after) || info.Size() != after.Size() || info.ModTime() != after.ModTime() || info.Mode() != after.Mode() {
		return entry, info, errors.New("distributiondata: source_changed_during_capture")
	}
	entry.Exists, entry.Size, entry.Mode = true, info.Size(), uint32(info.Mode())
	entry.ModifiedNS, entry.SHA256 = info.ModTime().UnixNano(), hex.EncodeToString(hash.Sum(nil))
	return entry, info, nil
}

func present(source SourceFingerprint, name string) bool {
	for _, file := range source.Files {
		if file.Name == name {
			return file.Exists
		}
	}
	return false
}
