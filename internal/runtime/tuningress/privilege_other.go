//go:build !darwin && !linux && !windows

package tuningress

func processElevated() bool { return false }
