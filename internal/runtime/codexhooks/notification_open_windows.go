//go:build windows

package codexhooks

import "os"

func openNotificationDescriptor(path string) (*os.File, error) { return os.Open(path) }
