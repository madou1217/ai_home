package accountbrowser

import "errors"

var (
	// ErrInvalidIdentity indicates that a ServerID, Provider, or AccountRef is
	// not in canonical valid form.
	ErrInvalidIdentity = errors.New("account browser identity is invalid")

	// ErrProfileNotFound indicates that no profile registry exists on disk for
	// the requested canonical identity.
	ErrProfileNotFound = errors.New("account browser profile not found")

	// ErrProfileCorrupt indicates that an existing profile directory or
	// metadata file is incomplete, malformed, oversized, or inconsistent with
	// the requested identity.
	ErrProfileCorrupt = errors.New("account browser profile is corrupt")

	// ErrUnsafePath indicates a rejected root, symlink, non-regular file,
	// path traversal attempt, or non-private permissions on owned paths.
	ErrUnsafePath = errors.New("account browser path is unsafe")

	// ErrHostUnavailable indicates that no browser Host runtime is attached to
	// the Service.
	ErrHostUnavailable = errors.New("account browser host is unavailable")
)
