//go:build windows

package main

// Windows uses per-process handle limits that are not managed through
// RLIMIT_NOFILE; the launcher already leaves enough handles for the server.
func raiseFileDescriptorLimit() {}
