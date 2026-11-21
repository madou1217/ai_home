//go:build !darwin && !windows

package accountbrowserhost

import (
	"context"
	"os"
	"os/exec"
)

// No unverified fallback to another browser, engine, or process model.
type processIdentity struct{}

func platformSupported() bool                        { return false }
func discover(context.Context) (installation, error) { return installation{}, ErrUnsupported }
func prepareCommand(*exec.Cmd)                       {}
func identifyProcess(int) (processIdentity, error)   { return processIdentity{}, ErrUnsupported }
func (processIdentity) signal(bool) error            { return ErrUnsupported }
func (processIdentity) empty() (bool, error)         { return false, ErrUnsupported }
func lockFile(*os.File) error                        { return ErrUnsupported }
func unlockFile(*os.File) error                      { return ErrUnsupported }

// Unsupported targets never reach these lifecycle methods.
type processFamily struct{}

func trackFamily(processIdentity) *processFamily { return &processFamily{} }
func (*processFamily) empty() (bool, error)      { return false, ErrUnsupported }
func (*processFamily) close()                    {}
