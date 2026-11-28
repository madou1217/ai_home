//go:build windows

package netguard

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	winDivertLayerNetwork   = 0
	winDivertExternalFilter = "outbound and not loopback"
	winDivertShutdownRecv   = 0x1
	invalidHandle           = ^uintptr(0)
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procCreateToolhelp32    = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32First      = kernel32.NewProc("Process32FirstW")
	procProcess32Next       = kernel32.NewProc("Process32NextW")
	winDivertOnce           sync.Once
	winDivertDLL            *syscall.DLL
	winDivertLoadErr        error
	winDivertOpenProc       *syscall.Proc
	winDivertRecvProc       *syscall.Proc
	winDivertCloseProc      *syscall.Proc
	winDivertShutdownProc   *syscall.Proc
	winDivertSendProc       *syscall.Proc
	iphlpapi                = syscall.NewLazyDLL("iphlpapi.dll")
	procGetExtendedTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")
	procGetExtendedUdpTable = iphlpapi.NewProc("GetExtendedUdpTable")
	processSnapshotFlag     = uintptr(0x00000002) // TH32CS_SNAPPROCESS
	winDivertDebug          = strings.TrimSpace(os.Getenv("AIH_NETGUARD_DEBUG")) != ""
)

type processEntry32 struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	Threads         uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

// WinDivertGuard is the Windows strict adapter that works with the signed
// WinDivert driver (no test signing or reboot).
//
// It drops outbound non-loopback IPv4/IPv6 TCP and UDP packets whose owning
// process belongs to the instance tree, using the Windows owner tables as the
// 5-tuple → PID bridge (WinDivert's NETWORK layer does not support processId).
// Apps that use the local proxy continue to work because loopback is outside
// the filter; apps that bypass it fail closed, including direct UDP/QUIC from
// the protected process tree.
//
// DNS note: Windows resolves names through the Dnscache service (svchost), so
// an application's DNS query is sent by svchost and cannot be attributed to
// the instance at this layer. Blocking local DNS therefore needs the Phase 5
// DNS policy; this guard only stops direct UDP including direct DNS queries
// the protected process itself makes.
//
// Limits: ICMP/raw-IP packets cannot be attributed to a PID at this layer and
// are not blocked; a packet sent between process creation and the owner-table
// entry is not attributed; process-ID reuse is handled by refreshing the PID
// set but not verified against process start time. The WFP callout adapter
// (wfp_windows.go) is the kernel-grade backend once test signing is available.
type WinDivertGuard struct {
	options Options

	mu       sync.Mutex
	handle   uintptr
	pids     map[int]uint64
	roots    map[int]uint64
	watcher  context.CancelFunc
	status   GuardStatus
	blocked  uint64
	applyErr string
	// transparent TCP redirect state (AIH_NETGUARD_TRANSPARENT=1).
	nat     *natTable
	relay   *redirectRelay
	inbound uintptr
}

// NewWinDivertGuard creates a strict Windows guard.
func NewWinDivertGuard(options Options) (Guard, error) {
	if options.Policy.Mode != ModeStrict {
		return NewNoop(options), nil
	}
	if err := options.Policy.Validate(options.ProxyURL); err != nil {
		return nil, err
	}
	if err := loadWinDivert(); err != nil {
		return nil, err
	}
	return &WinDivertGuard{
		options: options,
		pids:    make(map[int]uint64),
		roots:   make(map[int]uint64),
		status: GuardStatus{
			Mode:    ModeStrict,
			Backend: "windivert",
			DNSMode: options.Policy.DNS,
		},
	}, nil
}

func loadWinDivert() error {
	winDivertOnce.Do(func() {
		path := strings.TrimSpace(os.Getenv("AIH_WINDIVERT_DLL"))
		if path == "" {
			if executable, err := os.Executable(); err == nil {
				path = filepath.Join(filepath.Dir(executable), "WinDivert.dll")
			}
		}
		if path == "" {
			winDivertLoadErr = errors.New("找不到 WinDivert.dll；请将它放在 aih-netguard 同目录或设置 AIH_WINDIVERT_DLL")
			return
		}
		dll, err := syscall.LoadDLL(path)
		if err != nil {
			winDivertLoadErr = fmt.Errorf("加载 WinDivert.dll 失败: %w", err)
			return
		}
		winDivertDLL = dll
		winDivertOpenProc, winDivertLoadErr = dll.FindProc("WinDivertOpen")
		if winDivertLoadErr != nil {
			return
		}
		winDivertRecvProc, winDivertLoadErr = dll.FindProc("WinDivertRecv")
		if winDivertLoadErr != nil {
			return
		}
		winDivertCloseProc, winDivertLoadErr = dll.FindProc("WinDivertClose")
		if winDivertLoadErr != nil {
			return
		}
		winDivertShutdownProc, winDivertLoadErr = dll.FindProc("WinDivertShutdown")
		if winDivertLoadErr != nil {
			return
		}
		winDivertSendProc, winDivertLoadErr = dll.FindProc("WinDivertSend")
	})
	return winDivertLoadErr
}

func (guard *WinDivertGuard) Start(ctx context.Context) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	guard.status.Active = true
	if transparentEnabled() {
		if err := guard.startTransparent(ctx); err != nil {
			guard.status.Active = false
			return err
		}
	}
	// The caller normally calls SetProcessTree immediately after starting the
	// target suspended. If PIDs are already present, apply now.
	if len(guard.pids) > 0 {
		return guard.applyFilterLocked()
	}
	return nil
}

func (guard *WinDivertGuard) SetProcessTree(ctx context.Context, rootPID int, pids []int) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	if rootPID > 0 {
		created, ok := processCreateTime(rootPID)
		if winDivertDebug {
			fmt.Fprintf(os.Stderr, "windivert add root pid=%d created=%d ok=%v\n", rootPID, created, ok)
		}
		guard.roots[rootPID] = created
		guard.pids[rootPID] = created
	}
	for _, pid := range pids {
		if pid > 0 {
			created, ok := processCreateTime(pid)
			if winDivertDebug {
				fmt.Fprintf(os.Stderr, "windivert add pid=%d created=%d ok=%v\n", pid, created, ok)
			}
			guard.pids[pid] = created
		}
	}
	startWatcher := guard.watcher == nil && (len(guard.roots) > 0 || len(guard.pids) > 0) && ctx != nil
	var watcherCtx context.Context
	var cancel context.CancelFunc
	if startWatcher {
		watcherCtx, cancel = context.WithCancel(ctx)
		guard.watcher = cancel
	}
	guard.mu.Unlock()
	if startWatcher {
		go guard.trackProcessTree(watcherCtx)
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	return guard.applyFilterLocked()
}

// trackProcessTree polls the Windows process snapshot and adds all descendants
// of rootPID. This covers Chromium/Electron helpers created after the launch.
// A suspended launch narrows the initial race; future WFP tagging removes it.
func (guard *WinDivertGuard) trackProcessTree(ctx context.Context) {
	ticker := time.NewTicker(250 * time.Millisecond)
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

func (guard *WinDivertGuard) refreshDescendants() {
	guard.mu.Lock()
	changed := guard.pruneLocked()
	roots := make([]int, 0, len(guard.roots))
	for root := range guard.roots {
		roots = append(roots, root)
	}
	guard.mu.Unlock()
	if len(roots) == 0 {
		if changed {
			guard.mu.Lock()
			_ = guard.applyFilterLocked()
			guard.mu.Unlock()
		}
		return
	}
	var children []int
	for _, root := range roots {
		children = append(children, descendantPIDs(root)...)
	}
	guard.mu.Lock()
	for _, pid := range children {
		if _, exists := guard.pids[pid]; !exists {
			created, _ := processCreateTime(pid)
			guard.pids[pid] = created
			changed = true
		}
	}
	if changed {
		_ = guard.applyFilterLocked()
	}
	guard.mu.Unlock()
}

// pruneLocked drops PIDs whose process exited or whose PID was reused by a
// different process. Without this, a recycled PID would inherit the instance's
// protection and could cut an unrelated service (including sshd) off the
// network. The caller holds guard.mu.
func (guard *WinDivertGuard) pruneLocked() bool {
	changed := false
	for pid, created := range guard.roots {
		if !processStillMatches(pid, created) {
			if winDivertDebug {
				fmt.Fprintf(os.Stderr, "windivert prune root pid=%d\n", pid)
			}
			delete(guard.roots, pid)
			delete(guard.pids, pid)
			changed = true
		}
	}
	for pid, created := range guard.pids {
		if !processStillMatches(pid, created) {
			if winDivertDebug {
				fmt.Fprintf(os.Stderr, "windivert prune pid=%d\n", pid)
			}
			delete(guard.pids, pid)
			changed = true
		}
	}
	return changed
}

func (guard *WinDivertGuard) applyFilterLocked() error {
	if !guard.status.Active {
		return nil
	}
	pids := make([]int, 0, len(guard.pids))
	for pid := range guard.pids {
		if pid > 0 {
			pids = append(pids, pid)
		}
	}
	guard.status.ProtectedPIDs = len(pids)
	if len(pids) == 0 {
		return nil
	}
	filterPtr, err := syscall.BytePtrFromString(winDivertExternalFilter)
	if err != nil {
		guard.applyErr = err.Error()
		return err
	}
	handle, _, callErr := winDivertOpenProc.Call(
		uintptr(unsafe.Pointer(filterPtr)),
		uintptr(winDivertLayerNetwork),
		0,
		0,
	)
	if handle == invalidHandle || handle == 0 {
		message := "WinDivertOpen 失败"
		if callErr != nil && callErr != syscall.Errno(0) {
			message = fmt.Sprintf("%s: %v（需要管理员权限和同目录 WinDivert64.sys）", message, callErr)
		}
		guard.applyErr = message
		guard.status.LastError = message
		return errors.New(message)
	}
	old := guard.handle
	guard.handle = handle
	guard.applyErr = ""
	guard.status.LastError = ""
	go guard.drain(handle)
	if old != 0 && old != invalidHandle {
		_, _, _ = winDivertShutdownProc.Call(old, uintptr(winDivertShutdownRecv))
		_, _, _ = winDivertCloseProc.Call(old)
	}
	return nil
}

func (guard *WinDivertGuard) drain(handle uintptr) {
	if handle == 0 || handle == invalidHandle {
		return
	}
	packet := make([]byte, 65535)
	address := make([]byte, 80)
	for {
		var received uint32
		ok, _, _ := winDivertRecvProc.Call(
			handle,
			uintptr(unsafe.Pointer(&packet[0])),
			uintptr(len(packet)),
			uintptr(unsafe.Pointer(&received)),
			uintptr(unsafe.Pointer(&address[0])),
		)
		if ok == 0 {
			return
		}
		payload := packet[:received]
		target := guard.packetBelongsToInstance(payload)
		if target && guard.nat != nil {
			if rewritten := guard.rewriteOutbound(payload); rewritten != nil {
				var sent uint32
				_, _, _ = winDivertSendProc.Call(handle, uintptr(unsafe.Pointer(&rewritten[0])), uintptr(len(rewritten)), uintptr(unsafe.Pointer(&sent)), uintptr(unsafe.Pointer(&address[0])))
				continue
			}
		}
		if target {
			atomic.AddUint64(&guard.blocked, 1)
			continue
		}
		var sent uint32
		_, _, _ = winDivertSendProc.Call(
			handle,
			uintptr(unsafe.Pointer(&payload[0])),
			uintptr(len(payload)),
			uintptr(unsafe.Pointer(&sent)),
			uintptr(unsafe.Pointer(&address[0])),
		)
	}
}

// packetBelongsToInstance attributes an outbound packet to a PID using the
// Windows TCP/UDP owner tables. WinDivert's NETWORK layer cannot expose
// processId; the owner table is the supported bridge between the 5-tuple and
// the instance's process tree.
func (guard *WinDivertGuard) packetBelongsToInstance(packet []byte) bool {
	protocol, port, ok := transportSource(packet)
	if !ok {
		return false
	}
	family := uint16(syscall.AF_INET)
	if packet[0]>>4 == 6 {
		family = syscall.AF_INET6
	}
	pid := lookupOwnerPID(family, protocol, port)
	if pid <= 0 {
		if winDivertDebug {
			fmt.Fprintf(os.Stderr, "windivert unattributed v=%d proto=%d port=%d\n", packet[0]>>4, protocol, port)
		}
		return false
	}
	guard.mu.Lock()
	_, target := guard.pids[pid]
	guard.mu.Unlock()
	if winDivertDebug {
		fmt.Fprintf(os.Stderr, "windivert packet v=%d proto=%d port=%d pid=%d protected=%v\n", packet[0]>>4, protocol, port, pid, target)
	}
	return target
}

// transportSource extracts the transport protocol and source port from an
// IPv4 or IPv6 packet, walking the common IPv6 extension headers.
func transportSource(packet []byte) (byte, uint16, bool) {
	if len(packet) < 1 {
		return 0, 0, false
	}
	switch packet[0] >> 4 {
	case 4:
		if len(packet) < 20 {
			return 0, 0, false
		}
		headerLen := int(packet[0]&0x0f) * 4
		if headerLen < 20 || len(packet) < headerLen+4 {
			return 0, 0, false
		}
		protocol := packet[9]
		if protocol != 6 && protocol != 17 {
			return 0, 0, false
		}
		return protocol, binary.BigEndian.Uint16(packet[headerLen : headerLen+2]), true
	case 6:
		if len(packet) < 40 {
			return 0, 0, false
		}
		next := packet[6]
		offset := 40
		for hops := 0; hops < 8; hops++ {
			switch next {
			case 0, 43, 60: // hop-by-hop, routing, destination options
				if offset+2 > len(packet) {
					return 0, 0, false
				}
				length := (int(packet[offset+1]) + 1) * 8
				next = packet[offset]
				offset += length
			case 44: // fragment
				if offset+8 > len(packet) {
					return 0, 0, false
				}
				next = packet[offset]
				offset += 8
			case 51: // authentication header
				if offset+2 > len(packet) {
					return 0, 0, false
				}
				length := (int(packet[offset+1]) + 2) * 4
				next = packet[offset]
				offset += length
			case 6, 17:
				if offset+4 > len(packet) {
					return 0, 0, false
				}
				return next, binary.BigEndian.Uint16(packet[offset : offset+2]), true
			default:
				return 0, 0, false
			}
			if offset > len(packet) {
				return 0, 0, false
			}
		}
	}
	return 0, 0, false
}

// lookupOwnerPID maps a local TCP/UDP port to its owning PID. Results are
// cached briefly; the tables are queried only for ports not seen before.
func lookupOwnerPID(family uint16, protocol byte, port uint16) int {
	key := ownerKey{family: family, protocol: protocol, port: port}
	if value, ok := ownerCache.Load(key); ok {
		entry := value.(ownerCacheEntry)
		if entry.pid > 0 && time.Since(entry.at) < 3*time.Second {
			return entry.pid
		}
	}
	var pid int
	if protocol == 6 {
		pid = tcpOwnerPID(family, port)
	} else {
		pid = udpOwnerPID(family, port)
	}
	if pid > 0 {
		ownerCache.Store(key, ownerCacheEntry{pid: pid, at: time.Now()})
	}
	return pid
}

type ownerKey struct {
	family   uint16
	protocol byte
	port     uint16
}

type ownerCacheEntry struct {
	pid int
	at  time.Time
}

var ownerCache sync.Map

const (
	tcpTableOwnerPIDAll = 5
	udpTableOwnerPID    = 1
)

func tcpOwnerPID(family uint16, port uint16) int {
	if family == syscall.AF_INET6 {
		return queryOwnerPID(procGetExtendedTcpTable, family, tcpTableOwnerPIDAll, 56, 20, 52, port)
	}
	return queryOwnerPID(procGetExtendedTcpTable, family, tcpTableOwnerPIDAll, 24, 8, 20, port)
}

func udpOwnerPID(family uint16, port uint16) int {
	if family == syscall.AF_INET6 {
		return queryOwnerPID(procGetExtendedUdpTable, family, udpTableOwnerPID, 28, 20, 24, port)
	}
	return queryOwnerPID(procGetExtendedUdpTable, family, udpTableOwnerPID, 12, 4, 8, port)
}

func queryOwnerPID(proc *syscall.LazyProc, family uint16, tableClass uint32, rowSize, portOffset, pidOffset int, port uint16) int {
	var size uint32
	proc.Call(0, uintptr(unsafe.Pointer(&size)), 0, uintptr(family), uintptr(tableClass), 0)
	if size == 0 {
		return 0
	}
	buffer := make([]byte, size)
	result, _, _ := proc.Call(
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
		0, uintptr(family), uintptr(tableClass), 0,
	)
	if result != 0 {
		return 0
	}
	return findOwner(buffer, rowSize, portOffset, pidOffset, port)
}

func findOwner(buffer []byte, rowSize, portOffset, pidOffset int, port uint16) int {
	if len(buffer) < 4 {
		return 0
	}
	count := int(binary.LittleEndian.Uint32(buffer[:4]))
	offset := 4
	for index := 0; index < count && offset+rowSize <= len(buffer); index++ {
		row := buffer[offset : offset+rowSize]
		localPort := binary.LittleEndian.Uint32(row[portOffset : portOffset+4])
		if byteSwap16(uint16(localPort)) != port {
			offset += rowSize
			continue
		}
		return int(binary.LittleEndian.Uint32(row[pidOffset : pidOffset+4]))
	}
	return 0
}

func byteSwap16(value uint16) uint16 {
	return value<<8 | value>>8
}

func (guard *WinDivertGuard) Stop(context.Context) error {
	guard.mu.Lock()
	if guard.watcher != nil {
		guard.watcher()
		guard.watcher = nil
	}
	handle := guard.handle
	guard.handle = 0
	guard.status.Active = false
	guard.status.ProtectedPIDs = 0
	guard.pids = make(map[int]uint64)
	guard.roots = make(map[int]uint64)
	guard.mu.Unlock()
	if handle != 0 && handle != invalidHandle {
		_, _, _ = winDivertShutdownProc.Call(handle, uintptr(winDivertShutdownRecv))
		_, _, _ = winDivertCloseProc.Call(handle)
	}
	return nil
}

func (guard *WinDivertGuard) Status() GuardStatus {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	status := guard.status
	status.Blocked = atomic.LoadUint64(&guard.blocked)
	return status
}

func (guard *WinDivertGuard) Audit(context.Context) (Audit, error) {
	return Audit{
		DNSMode: guard.options.Policy.DNS,
		Notes:   []string{"P0 guard: non-loopback packets from the instance process tree are dropped"},
	}, nil
}

func descendantPIDs(root int) []int {
	snapshot, _, _ := procCreateToolhelp32.Call(processSnapshotFlag, 0)
	if snapshot == invalidHandle {
		return nil
	}
	defer syscall.CloseHandle(syscall.Handle(snapshot))
	entries := make(map[uint32][]uint32)
	var entry processEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	ok, _, _ := procProcess32First.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	for ok != 0 {
		entries[entry.ParentProcessID] = append(entries[entry.ParentProcessID], entry.ProcessID)
		entry.Size = uint32(unsafe.Sizeof(entry))
		ok, _, _ = procProcess32Next.Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	}
	var out []int
	queue := []uint32{uint32(root)}
	seen := map[uint32]struct{}{uint32(root): {}}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range entries[parent] {
			if _, exists := seen[child]; exists {
				continue
			}
			seen[child] = struct{}{}
			queue = append(queue, child)
			out = append(out, int(child))
		}
	}
	return out
}
