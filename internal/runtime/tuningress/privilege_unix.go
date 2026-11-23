//go:build darwin || linux

package tuningress

import "os"

func processElevated() bool {
	return os.Geteuid() == 0
}
