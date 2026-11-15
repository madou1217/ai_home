//go:build windows

package codexrollout

import "os"

func openHistoryFile(path string) (*os.File, error) { return os.Open(path) }
