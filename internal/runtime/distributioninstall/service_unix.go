//go:build !windows

package distributioninstall

import (
	"context"
	"errors"
)

func startWindowsService(context.Context, Options) error { return errors.New("wrong_platform") }
