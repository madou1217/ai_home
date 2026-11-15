//go:build windows

package codexstatepage

import "os"

func openTitleFile(path string) (*os.File, error) { return os.Open(path) }
