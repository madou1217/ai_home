//go:build !windows

package persistent

import "runtime"

func osPlatform() string { return runtime.GOOS }
