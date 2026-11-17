//go:build !linux && !darwin && !windows

package platform

import (
	"errors"
	"os"
)

func Lock(*os.File) error {
	return errors.New("distribution updates require Linux, Darwin or Windows OS locks")
}
func Unlock(*os.File) error { return nil }
func Contended(error) bool  { return false }

func ProcessAlive(int) bool { return false }
