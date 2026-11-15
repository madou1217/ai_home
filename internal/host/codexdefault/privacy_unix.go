//go:build !windows

package codexdefault

import "os"

func securePrivateFile(file *os.File) error          { return file.Chmod(0o600) }
func privateFile(path string, info os.FileInfo) bool { return info.Mode().Perm()&0o077 == 0 }
func sameMode(a, b os.FileMode) bool                 { return a == b }
