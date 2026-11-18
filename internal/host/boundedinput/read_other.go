//go:build !darwin && !linux && !windows

package boundedinput

import (
	"context"
	"os"
)

func readPlatform(context.Context, *os.File, int64) ([]byte, error) {
	return nil, ErrUnsupportedInput
}
