//go:build windows

package netguard

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	wfpDevicePath          = `\\.\AihNetGuard`
	wfpIoctlSetPIDs        = 0x222004
	wfpIoctlGetStatus      = 0x222008
	wfpMaxPIDs             = 512
	wfpProcessPollInterval = 250 * time.Millisecond
)

// WFPGuard is the strict Windows backend. It talks to the aih-netguard WFP
// callout driver, which blocks ALE_AUTH_CONNECT for the supplied PIDs while
// permitting loopback (the instance's proxy listener and AIH's local
// gateway/OAuth callbacks).
//
// DNS note: Windows resolves names through Dnscache (svchost); those queries
// carry svchost's PID, not the instance's. Per-process enforcement therefore
// cannot stop resolver traffic at this layer — that belongs to the Phase 5
// DNS policy.
//
// The driver keeps one global PID set, so the process-wide controller unions
// the process trees of every live guard and pushes the union on each change.
type WFPGuard struct {
	options Options

	mu      sync.Mutex
	pids    map[int]struct{}
	rootPID int
	watcher context.CancelFunc
	active  bool
	status  GuardStatus
}

type wfpController struct {
	mu     sync.Mutex
	handle syscall.Handle
	guards map[*WFPGuard]struct{}
}

var (
	wfpControllerMu   sync.Mutex
	wfpControllerInst *wfpController
)

// NewWFPGuard creates a strict guard backed by the WFP callout driver. It
// fails when the driver device is not present (driver not installed, not
// started, or AIH is not running as administrator).
func NewWFPGuard(options Options) (Guard, error) {
	if options.Policy.Mode != ModeStrict {
		return NewNoop(options), nil
	}
	if err := options.Policy.Validate(options.ProxyURL); err != nil {
		return nil, err
	}
	controller, err := sharedWFPController()
	if err != nil {
		return nil, err
	}
	guard := &WFPGuard{
		options: options,
		pids:    make(map[int]struct{}),
		status: GuardStatus{
			Mode:    ModeStrict,
			Backend: "wfp",
		},
	}
	controller.register(guard)
	return guard, nil
}

// sharedWFPController returns the process-wide driver handle, opening it on
// first use. The handle stays open for the process lifetime: an empty PID set
// means the driver blocks nothing, and keeping it avoids reopen races while
// multiple guards start and stop.
func sharedWFPController() (*wfpController, error) {
	wfpControllerMu.Lock()
	defer wfpControllerMu.Unlock()
	if wfpControllerInst != nil {
		return wfpControllerInst, nil
	}
	handle, err := openWFPDevice()
	if err != nil {
		return nil, err
	}
	wfpControllerInst = &wfpController{
		handle: handle,
		guards: make(map[*WFPGuard]struct{}),
	}
	return wfpControllerInst, nil
}

func currentWFPController() *wfpController {
	wfpControllerMu.Lock()
	defer wfpControllerMu.Unlock()
	return wfpControllerInst
}

func openWFPDevice() (syscall.Handle, error) {
	path, err := syscall.UTF16PtrFromString(wfpDevicePath)
	if err != nil {
		return 0, err
	}
	handle, err := syscall.CreateFile(
		path,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0,
		nil,
		syscall.OPEN_EXISTING,
		0,
		0,
	)
	if err != nil {
		return 0, fmt.Errorf("打开 %s 失败（驱动未安装/未启动或缺少管理员权限）: %w", wfpDevicePath, err)
	}
	return handle, nil
}

// wfpDeviceAvailable reports whether the driver device can be opened. It is
// used to choose the strict backend without forcing the WFP path.
func wfpDeviceAvailable() bool {
	handle, err := openWFPDevice()
	if err != nil {
		return false
	}
	_ = syscall.CloseHandle(handle)
	return true
}

func (controller *wfpController) register(guard *WFPGuard) {
	controller.mu.Lock()
	controller.guards[guard] = struct{}{}
	controller.mu.Unlock()
}

func (controller *wfpController) unregister(guard *WFPGuard) {
	controller.mu.Lock()
	delete(controller.guards, guard)
	controller.mu.Unlock()
	_ = controller.applyUnion()
}

// applyUnion pushes the union of all guard process sets to the driver.
func (controller *wfpController) applyUnion() error {
	controller.mu.Lock()
	union := make(map[int]struct{})
	for guard := range controller.guards {
		guard.mu.Lock()
		for pid := range guard.pids {
			union[pid] = struct{}{}
		}
		guard.mu.Unlock()
	}
	pids := make([]int, 0, len(union))
	for pid := range union {
		pids = append(pids, pid)
	}
	controller.mu.Unlock()
	return controller.setPIDs(pids)
}

func (controller *wfpController) setPIDs(pids []int) error {
	if len(pids) > wfpMaxPIDs {
		pids = pids[:wfpMaxPIDs]
	}
	input := make([]byte, 4+4*len(pids))
	binary.LittleEndian.PutUint32(input[:4], uint32(len(pids)))
	for index, pid := range pids {
		binary.LittleEndian.PutUint32(input[4+4*index:], uint32(pid))
	}
	if err := deviceIoControl(controller.handle, wfpIoctlSetPIDs, input, nil); err != nil {
		return fmt.Errorf("设置 WFP PID 集合失败: %w", err)
	}
	return nil
}

func (controller *wfpController) status() (count uint32, blocked uint32, err error) {
	output := make([]byte, 8)
	if err := deviceIoControl(controller.handle, wfpIoctlGetStatus, nil, output); err != nil {
		return 0, 0, err
	}
	count = binary.LittleEndian.Uint32(output[:4])
	blocked = binary.LittleEndian.Uint32(output[4:8])
	return count, blocked, nil
}

func deviceIoControl(handle syscall.Handle, code uint32, input []byte, output []byte) error {
	var inPtr *byte
	if len(input) > 0 {
		inPtr = &input[0]
	}
	var outPtr *byte
	if len(output) > 0 {
		outPtr = &output[0]
	}
	var returned uint32
	if err := syscall.DeviceIoControl(handle, code, inPtr, uint32(len(input)), outPtr, uint32(len(output)), &returned, nil); err != nil {
		return err
	}
	if len(output) > 0 && returned < uint32(len(output)) {
		return fmt.Errorf("设备返回数据不足: %d < %d", returned, len(output))
	}
	return nil
}

func (guard *WFPGuard) Start(context.Context) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	guard.active = true
	guard.status.Active = true
	guard.mu.Unlock()
	return nil
}

func (guard *WFPGuard) SetProcessTree(ctx context.Context, rootPID int, pids []int) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	if rootPID > 0 {
		guard.rootPID = rootPID
	}
	for _, pid := range pids {
		if pid > 0 {
			guard.pids[pid] = struct{}{}
		}
	}
	if guard.rootPID > 0 {
		guard.pids[guard.rootPID] = struct{}{}
	}
	startWatcher := guard.watcher == nil && guard.rootPID > 0 && ctx != nil
	var watcherCtx context.Context
	var cancel context.CancelFunc
	if startWatcher {
		watcherCtx, cancel = context.WithCancel(ctx)
		guard.watcher = cancel
	}
	guard.status.ProtectedPIDs = len(guard.pids)
	guard.mu.Unlock()

	if startWatcher {
		go guard.trackProcessTree(watcherCtx)
	}
	controller, err := sharedWFPController()
	if err != nil {
		return err
	}
	return controller.applyUnion()
}

// trackProcessTree polls the Windows process snapshot and adds all descendants
// of the root PID, covering helpers spawned after the launch.
func (guard *WFPGuard) trackProcessTree(ctx context.Context) {
	ticker := time.NewTicker(wfpProcessPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			guard.refreshDescendants()
		}
	}
}

func (guard *WFPGuard) refreshDescendants() {
	guard.mu.Lock()
	root := guard.rootPID
	active := guard.active
	guard.mu.Unlock()
	if root <= 0 || !active {
		return
	}
	children := descendantPIDs(root)
	if len(children) == 0 {
		return
	}
	changed := false
	guard.mu.Lock()
	for _, pid := range children {
		if _, exists := guard.pids[pid]; !exists {
			guard.pids[pid] = struct{}{}
			changed = true
		}
	}
	guard.status.ProtectedPIDs = len(guard.pids)
	guard.mu.Unlock()
	if !changed {
		return
	}
	if controller := currentWFPController(); controller != nil {
		if err := controller.applyUnion(); err != nil {
			guard.mu.Lock()
			guard.status.LastError = err.Error()
			guard.mu.Unlock()
		}
	}
}

func (guard *WFPGuard) Stop(context.Context) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	if guard.watcher != nil {
		guard.watcher()
		guard.watcher = nil
	}
	guard.active = false
	guard.status.Active = false
	guard.mu.Unlock()
	if controller := currentWFPController(); controller != nil {
		controller.unregister(guard)
	}
	return nil
}

func (guard *WFPGuard) Status() GuardStatus {
	guard.mu.Lock()
	status := guard.status
	guard.mu.Unlock()
	if controller := currentWFPController(); controller != nil {
		if count, blocked, err := controller.status(); err == nil {
			status.Blocked = uint64(blocked)
			if status.ProtectedPIDs == 0 {
				status.ProtectedPIDs = int(count)
			}
		} else {
			status.LastError = err.Error()
		}
	}
	return status
}

func (guard *WFPGuard) Audit(context.Context) (Audit, error) {
	return Audit{
		DNSMode: guard.options.Policy.DNS,
		Notes: []string{
			"WFP ALE_AUTH_CONNECT blocks external destinations for the instance PID set",
			"loopback is permitted for the instance proxy and AIH local services",
		},
	}, nil
}

// strictWindowsBackendName returns the configured backend override.
func strictWindowsBackendName() string {
	return strings.ToLower(strings.TrimSpace(os.Getenv("AIH_NETGUARD_BACKEND")))
}
