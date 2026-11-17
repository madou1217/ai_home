//go:build !windows

package distributiondata

import (
	"errors"
	"fmt"
	"os"
)

func syncDir(path string) (resultErr error) {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("distributiondata: sync private directory: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	return f.Sync()
}
