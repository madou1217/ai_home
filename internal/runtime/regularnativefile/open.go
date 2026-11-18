// Package regularnativefile acquires read-only regular-file handles for static
// native inspection. It does not authenticate writers or bound filesystem I/O.
package regularnativefile

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrUnsupported = errors.New("regular_native_file_unsupported")
	ErrInvalid     = errors.New("regular_native_file_invalid")
)

// Options applies to both the pathname observation and the acquired handle.
// MaxBytes == 0 imposes no size cap; a negative value is invalid.
type Options struct {
	MaxBytes          int64
	RequireExecutable bool
}

// Supported does no filesystem work. Unsupported platforms fail before lookup.
func Supported() bool { return platformSupported }

func acceptable(info os.FileInfo, options Options) bool {
	return info != nil && info.Mode().IsRegular() && info.Size() >= 0 &&
		(options.MaxBytes == 0 || info.Size() <= options.MaxBytes) &&
		(!options.RequireExecutable || info.Mode().Perm()&0111 != 0)
}

// Open avoids a Unix FIFO writer rendezvous at the initial open, then rejects
// nonregular or mismatched handles before consumers can read any data.
// Path lookup/stat/regular-file reads still have no general latency bound.
func Open(path string, options Options) (*os.File, error) {
	if !Supported() {
		return nil, ErrUnsupported
	}
	if options.MaxBytes < 0 || !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
		return nil, ErrInvalid
	}
	before, err := os.Stat(path)
	if err != nil || !acceptable(before, options) {
		return nil, ErrInvalid
	}
	file, err := openNative(path)
	if err != nil {
		return nil, ErrInvalid
	}
	opened, err := file.Stat()
	if err != nil || !acceptable(opened, options) || !os.SameFile(before, opened) {
		file.Close()
		return nil, ErrInvalid
	}
	return file, nil
}

// Verify checks only this handle after inspection. Equal observations cannot
// prove immutable contents or exclude an unobserved same-inode modification.
func Verify(file *os.File, before os.FileInfo, options Options) error {
	if file == nil || options.MaxBytes < 0 || !acceptable(before, options) {
		return ErrInvalid
	}
	after, err := file.Stat()
	if err != nil || !acceptable(after, options) || !os.SameFile(before, after) ||
		before.Size() != after.Size() || before.Mode() != after.Mode() || !before.ModTime().Equal(after.ModTime()) {
		return ErrInvalid
	}
	return nil
}
