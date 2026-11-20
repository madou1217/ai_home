//go:build !darwin && !linux && !windows

package artifactstore

import (
	"os"
	"time"
)

func accessTime(info os.FileInfo) time.Time { return info.ModTime() }
