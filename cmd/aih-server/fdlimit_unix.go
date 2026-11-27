//go:build !windows

package main

import "syscall"

// raiseFileDescriptorLimit lifts the soft RLIMIT_NOFILE inherited from launchd
// (default 256 on macOS) to the hard limit, capped at a sane target.
//
// 256 descriptors is not enough for the server under normal use: each SSE
// client, PTY, plugin child and SQLite connection consumes several. Hitting the
// limit surfaces as "accept: too many open files" and 5xx on unrelated pages.
// Raising the soft limit at startup makes the server independent of the
// launcher's defaults; the plist and AI Home.app also set it for child
// processes.
func raiseFileDescriptorLimit() {
	var limit syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &limit); err != nil {
		return
	}
	const target uint64 = 262144
	desired := target
	if limit.Max != 0 && limit.Max != ^uint64(0) && desired > limit.Max {
		desired = limit.Max
	}
	if limit.Cur >= desired {
		return
	}
	limit.Cur = desired
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &limit)
}
