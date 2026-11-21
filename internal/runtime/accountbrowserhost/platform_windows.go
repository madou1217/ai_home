//go:build windows

package accountbrowserhost

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processIdentity struct {
	pid     int
	started uint64
}

func platformSupported() bool { return true }
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

func discover(ctx context.Context) (installation, error) {
	candidates := []string{}
	for _, root := range []string{os.Getenv("PROGRAMFILES(X86)"), os.Getenv("PROGRAMFILES"), os.Getenv("LOCALAPPDATA")} {
		if root != "" {
			candidates = append(candidates, filepath.Join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	if path, err := exec.LookPath("msedge.exe"); err == nil {
		candidates = append([]string{path}, candidates...)
	}
	for _, candidate := range candidates {
		select {
		case <-ctx.Done():
			return installation{}, ctx.Err()
		default:
		}
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0) {
			if err := verifyStableEdgeSignature(candidate); err == nil {
				return installation{identity: BrowserIdentity{Vendor: "Microsoft Edge", Channel: "stable", Version: "installed"}, executable: candidate}, nil
			}
		}
	}
	return installation{}, ErrUnavailable
}

func processStarted(pid int) (uint64, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(h)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), nil
}

func identifyProcess(pid int) (processIdentity, error) {
	if pid <= 1 {
		return processIdentity{}, ErrRecoveryRequired
	}
	started, err := processStarted(pid)
	if err != nil {
		return processIdentity{}, ErrRecoveryRequired
	}
	return processIdentity{pid: pid, started: started}, nil
}

func (p processIdentity) same() bool {
	current, err := identifyProcess(p.pid)
	return err == nil && current == p
}

func (p processIdentity) signal(force bool) error {
	if !p.same() {
		return ErrRecoveryRequired
	}
	args := []string{"/PID", strconv.Itoa(p.pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	if err := exec.Command("taskkill", args...).Run(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return ErrRecoveryRequired
	}
	return nil
}
func (p processIdentity) empty() (bool, error) {
	current, err := identifyProcess(p.pid)
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return true, nil
		}
		return false, ErrRecoveryRequired
	}
	return current != p, nil
}

func lockFile(file *os.File) error {
	o := new(windows.Overlapped)
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	return windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, o)
}
func unlockFile(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, new(windows.Overlapped))
}

type processFamily struct{ root processIdentity }

func trackFamily(root processIdentity) *processFamily { return &processFamily{root: root} }
func (f *processFamily) empty() (bool, error)         { return f.root.empty() }
func (*processFamily) close()                         {}

func verifyStableEdgeSignature(path string) error {
	filePath, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	fileInfo := windows.WinTrustFileInfo{
		Size:     uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})),
		FilePath: filePath,
	}
	trust := windows.WinTrustData{
		Size:                            uint32(unsafe.Sizeof(windows.WinTrustData{})),
		UIChoice:                        windows.WTD_UI_NONE,
		RevocationChecks:                windows.WTD_REVOKE_NONE,
		UnionChoice:                     windows.WTD_CHOICE_FILE,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&fileInfo),
		StateAction:                     windows.WTD_STATEACTION_VERIFY,
		ProvFlags:                       windows.WTD_SAFER_FLAG,
		UIContext:                       windows.WTD_UICONTEXT_EXECUTE,
	}
	if err := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &trust); err != nil {
		return fmt.Errorf("edge authenticode verification failed: %w", err)
	}
	trust.StateAction = windows.WTD_STATEACTION_CLOSE
	_ = windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &trust)
	return nil
}
