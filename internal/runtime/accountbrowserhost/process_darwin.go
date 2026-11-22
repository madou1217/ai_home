//go:build darwin

package accountbrowserhost

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/unix"
)

type processIdentity struct {
	pid  int
	born unix.Timeval
}

func platformSupported() bool                   { return true }
func processStartMarker(processIdentity) uint64 { return 0 }
func prepareCommand(cmd *exec.Cmd)              { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

func identifyProcess(pid int) (processIdentity, error) {
	if pid <= 1 {
		return processIdentity{}, ErrRecoveryRequired
	}
	proc, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || int(proc.Proc.P_pid) != pid || int(proc.Eproc.Pgid) != pid || int(proc.Eproc.Ppid) != os.Getpid() {
		return processIdentity{}, ErrRecoveryRequired
	}
	return processIdentity{pid: pid, born: proc.Proc.P_starttime}, nil
}

func (p processIdentity) signal(force bool) error {
	current, err := identifyProcess(p.pid)
	if err != nil || current != p {
		return ErrRecoveryRequired
	}
	signal := unix.SIGTERM
	if force {
		signal = unix.SIGKILL
	}
	if err := unix.Kill(-p.pid, signal); err != nil && !errors.Is(err, unix.ESRCH) {
		return ErrRecoveryRequired
	}
	return nil
}

func (p processIdentity) empty() (bool, error) {
	if p.pid <= 1 || p.born == (unix.Timeval{}) {
		return false, ErrRecoveryRequired
	}
	err := unix.Kill(-p.pid, 0)
	if errors.Is(err, unix.ESRCH) {
		return true, nil
	}
	if err != nil {
		return false, ErrRecoveryRequired
	}
	return false, nil
}

func lockFile(file *os.File) error {
	err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return ErrBusy
	}
	return err
}
func unlockFile(file *os.File) error { return unix.Flock(int(file.Fd()), unix.LOCK_UN) }
