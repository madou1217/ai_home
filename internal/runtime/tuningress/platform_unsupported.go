//go:build !darwin && !linux && !windows

package tuningress

func platformSupported() bool { return false }
