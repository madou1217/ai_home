// Package kqueuewatch provides a macOS kqueue watcher that watches directory
// vnodes directly instead of expanding them into every child file.
//
// fsnotify's kqueue backend opens an fd for every child of a watched directory
// and does not release those internal fds on Close. A WebUI projects/peer SSE
// reconnect therefore leaks hundreds or thousands of descriptors until the
// server hits its RLIMIT_NOFILE. This watcher keeps one fd per registered path
// and re-arms deleted/replaced files explicitly.
package kqueuewatch

// Op is a filesystem change bitmask.
type Op uint32

const (
	// Write is a file content write or a directory entry change.
	Write Op = 1 << iota
	// Create is synthesized for directory entry changes.
	Create
	// Remove means the watched path was deleted.
	Remove
	// Rename means the watched path was renamed or atomically replaced.
	Rename
	// Chmod means attributes changed without content changes.
	Chmod
)

// Has reports whether all bits in target are set.
func (op Op) Has(target Op) bool { return op&target == target }

// Event is one change for a registered path.
type Event struct {
	Path string
	Op   Op
}

// Watcher watches a set of explicit paths. Directories are watched as vnodes:
// a write event means "an entry was added/removed", not a child path.
type Watcher interface {
	Add(path string) error
	Remove(path string) error
	Events() <-chan Event
	Errors() <-chan error
	Close() error
}
