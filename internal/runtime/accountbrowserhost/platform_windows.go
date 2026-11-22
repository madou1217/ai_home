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

func platformSupported() bool                            { return true }
func processStartMarker(identity processIdentity) uint64 { return identity.started }

// A Windows launch remains suspended until the root is assigned to its Job
// Object and resume is attempted. Before that boundary the root Process handle
// is the complete owned family; no renderer or GPU child can have been created.
func (p *hostProcess) canReleaseWithoutFamily() bool {
	return p != nil && !p.resumeAttempted && p.family == nil
}

func (p *hostProcess) recoverFamily() error {
	if p == nil || p.family != nil || p.resumeAttempted || p.cmd == nil || p.cmd.Process == nil {
		return ErrRecoveryRequired
	}
	identity, err := identifyProcess(p.cmd.Process.Pid)
	if err != nil {
		return err
	}
	family := trackFamily(identity)
	if err := family.attach(p.cmd); err != nil {
		family.close()
		return err
	}
	p.identity = identity
	p.family = family
	return nil
}
func prepareCommand(cmd *exec.Cmd) {
	// Keep the Edge primary thread suspended until it is inside our Job Object.
	// This closes the window in which Edge could create renderer/GPU children
	// before the supervisor obtains containment ownership.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_SUSPENDED}
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
		return processIdentity{}, err
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
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_INVALID_HANDLE) {
			return true, nil
		}
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return false, ErrRecoveryRequired
		}
		return false, err
	}
	if current != p {
		// The PID is alive but no longer denotes the process we launched. Treat
		// this as an uncertain lifecycle, never as an empty process family: a
		// reused PID must not release the profile lock or active marker.
		return false, ErrRecoveryRequired
	}
	return false, nil
}

func lockFile(file *os.File) error {
	o := new(windows.Overlapped)
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	return windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, o)
}
func unlockFile(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, new(windows.Overlapped))
}

type jobBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type processFamily struct {
	root processIdentity
	job  windows.Handle
}

func trackFamily(root processIdentity) *processFamily { return &processFamily{root: root} }

func (f *processFamily) attach(cmd *exec.Cmd) error {
	if f == nil || cmd == nil || cmd.Process == nil {
		return ErrRecoveryRequired
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(job, process); err != nil {
		_ = windows.CloseHandle(job)
		return err
	}
	f.job = job
	return nil
}

func (f *processFamily) resume(cmd *exec.Cmd) error {
	if f == nil || f.job == 0 || cmd == nil || cmd.Process == nil {
		return ErrRecoveryRequired
	}
	return resumeSuspendedProcess(cmd.Process.Pid)
}

func resumeSuspendedProcess(pid int) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)

	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return err
	}
	var lastErr error
	for {
		if entry.OwnerProcessID == uint32(pid) {
			thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if err != nil {
				lastErr = err
			} else {
				_, resumeErr := windows.ResumeThread(thread)
				_ = windows.CloseHandle(thread)
				if resumeErr == nil {
					return nil
				}
				lastErr = resumeErr
			}
		}
		err := windows.Thread32Next(snapshot, &entry)
		if err == nil {
			continue
		}
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			if lastErr != nil {
				return lastErr
			}
			return ErrRecoveryRequired
		}
		return err
	}
}

func (f *processFamily) terminate() error {
	if f == nil || f.job == 0 {
		return ErrRecoveryRequired
	}
	if err := windows.TerminateJobObject(f.job, 1); err != nil {
		return ErrRecoveryRequired
	}
	return nil
}

func (f *processFamily) empty() (bool, error) {
	if f == nil {
		return false, ErrRecoveryRequired
	}
	if f.job == 0 {
		return f.root.empty()
	}
	var info jobBasicAccountingInformation
	var returned uint32
	if err := windows.QueryInformationJobObject(f.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), &returned); err != nil {
		return false, ErrRecoveryRequired
	}
	return info.ActiveProcesses == 0, nil
}

func (f *processFamily) close() {
	if f != nil && f.job != 0 {
		_ = windows.CloseHandle(f.job)
		f.job = 0
	}
}

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
