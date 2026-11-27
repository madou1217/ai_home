//go:build !darwin

package webuiprojectsapi

// newProjectWatchSource uses fsnotify outside macOS: inotify does not expand
// directories into child descriptors, so the macOS leak does not apply.
func newProjectWatchSource() (projectWatchSource, error) {
	return newFsnotifyProjectWatchSource()
}
