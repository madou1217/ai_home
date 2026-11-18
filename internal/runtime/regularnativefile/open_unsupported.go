//go:build !darwin && !linux

package regularnativefile

import "os"

const platformSupported = false

func openNative(string) (*os.File, error) { return nil, ErrUnsupported }
