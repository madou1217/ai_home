//go:build linux

package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

const linuxCgroupRoot = "/sys/fs/cgroup/aih-netguard"

// LinuxGuard enforces strict_proxy for a cgroup v2 process tree using an
// nftables output chain: loopback is allowed (proxy/AIH gateway/MCP), every
// other external connection from the cgroup is dropped.
//
// It requires cgroup v2 and passwordless sudo for `mkdir`, `tee`/`sh`, and
// `nft`. The process tree inherits the cgroup automatically, so child
// processes are covered without PID polling.
type LinuxGuard struct {
	options Options

	mu        sync.Mutex
	id        string
	cgroup    string
	table     string
	started   bool
	protected int
	dnsBridge *DoHBridge
}

// NewLinuxGuard creates a Linux strict guard.
func NewLinuxGuard(options Options) (Guard, error) {
	if options.Policy.Mode != ModeStrict {
		return NewNoop(options), nil
	}
	if err := options.Policy.Validate(options.ProxyURL); err != nil {
		return nil, err
	}
	id := sanitizeID(options.InstanceID)
	if id == "" {
		return nil, errors.New("Linux strict guard 需要实例 ID")
	}
	return &LinuxGuard{
		options: options,
		id:      id,
		cgroup:  linuxCgroupRoot + "/" + id,
		table:   "aih_ng_" + id,
	}, nil
}

func (guard *LinuxGuard) Start(ctx context.Context) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	if guard.started {
		return nil
	}
	if err := sudoRun(ctx, "mkdir", "-p", guard.cgroup); err != nil {
		return fmt.Errorf("创建 cgroup 失败: %w", err)
	}
	// Recreate the table so stale rules from a crashed run cannot accumulate.
	if guard.dnsBridge != nil {
		_ = guard.dnsBridge.Close()
		guard.dnsBridge = nil
	}
	_ = sudoRun(ctx, "nft", "delete", "table", "inet", guard.table+"_dns")
	_ = sudoRun(ctx, "nft", "delete", "table", "inet", guard.table)
	if err := sudoRun(ctx, "nft", "add", "table", "inet", guard.table); err != nil {
		return fmt.Errorf("创建 nft table 失败: %w", err)
	}
	if err := sudoRun(ctx, "nft", "add", "chain", "inet", guard.table, "output",
		"{ type filter hook output priority 0; policy accept; }"); err != nil {
		return fmt.Errorf("创建 nft chain 失败: %w", err)
	}
	path := "aih-netguard/" + guard.id
	if guard.options.Policy.DNS == DNSBridge && guard.options.ProxyURL != "" {
		dnsTable := guard.table + "_dns"
		if err := sudoRun(ctx, "nft", "add", "table", "inet", dnsTable); err != nil {
			return fmt.Errorf("创建 DNS nat table 失败: %w", err)
		}
		if err := sudoRun(ctx, "nft", "add", "chain", "inet", dnsTable, "output",
			"{ type nat hook output priority -100; policy accept; }"); err != nil {
			return fmt.Errorf("创建 DNS nat chain 失败: %w", err)
		}
		bridge, err := NewDoHBridge(guard.options.ProxyURL, "https://1.1.1.1/dns-query")
		if err != nil {
			_ = sudoRun(context.Background(), "nft", "delete", "table", "inet", guard.table)
			return fmt.Errorf("启动 DoH 桥失败: %w", err)
		}
		guard.dnsBridge = bridge
		_, port, splitErr := net.SplitHostPort(bridge.Addr())
		if splitErr != nil {
			_ = bridge.Close()
			return splitErr
		}
		redirect := port
		rulesWithDNS := [][]string{
			{"add", "rule", "inet", dnsTable, "output", "socket", "cgroupv2", "level", "2", strconv.Quote(path), "udp", "dport", "53", "redirect", "to", ":" + redirect},
			{"add", "rule", "inet", dnsTable, "output", "socket", "cgroupv2", "level", "2", strconv.Quote(path), "tcp", "dport", "53", "redirect", "to", ":" + redirect},
		}
		for _, rule := range rulesWithDNS {
			if err := sudoRun(ctx, "nft", rule...); err != nil {
				_ = bridge.Close()
				_ = sudoRun(context.Background(), "nft", "delete", "table", "inet", guard.table)
				return fmt.Errorf("安装 DNS redirect 规则失败: %w", err)
			}
		}
	}
	rules := [][]string{
		{"add", "rule", "inet", guard.table, "output", "socket", "cgroupv2", "level", "2", strconv.Quote(path), "ip", "daddr", "127.0.0.0/8", "accept"},
		{"add", "rule", "inet", guard.table, "output", "socket", "cgroupv2", "level", "2", strconv.Quote(path), "ip6", "daddr", "::1", "accept"},
		{"add", "rule", "inet", guard.table, "output", "socket", "cgroupv2", "level", "2", strconv.Quote(path), "drop"},
	}
	for _, rule := range rules {
		if err := sudoRun(ctx, "nft", rule...); err != nil {
			_ = sudoRun(context.Background(), "nft", "delete", "table", "inet", guard.table)
			return fmt.Errorf("安装 nft 规则失败: %w", err)
		}
	}
	guard.started = true
	return nil
}

func (guard *LinuxGuard) SetProcessTree(ctx context.Context, rootPID int, pids []int) error {
	if guard == nil {
		return errors.New("netguard: nil guard")
	}
	guard.mu.Lock()
	started := guard.started
	guard.mu.Unlock()
	if !started {
		if err := guard.Start(ctx); err != nil {
			return err
		}
	}
	seen := make(map[int]struct{})
	for _, pid := range pids {
		if pid > 0 {
			seen[pid] = struct{}{}
		}
	}
	if rootPID > 0 {
		seen[rootPID] = struct{}{}
		for _, pid := range linuxDescendants(rootPID) {
			seen[pid] = struct{}{}
		}
	}
	for pid := range seen {
		// Writing a PID moves the process; descendants inherit the cgroup.
		script := "echo " + strconv.Itoa(pid) + " > " + shellQuote(guard.cgroup+"/cgroup.procs")
		if err := sudoRun(ctx, "sh", "-c", script); err != nil {
			return fmt.Errorf("将 PID %d 加入 cgroup 失败: %w", pid, err)
		}
	}
	guard.mu.Lock()
	guard.protected = len(seen)
	guard.mu.Unlock()
	return nil
}

func (guard *LinuxGuard) Stop(ctx context.Context) error {
	if guard == nil {
		return nil
	}
	guard.mu.Lock()
	started := guard.started
	guard.started = false
	guard.mu.Unlock()
	if !started {
		return nil
	}
	if guard.dnsBridge != nil {
		_ = guard.dnsBridge.Close()
		guard.dnsBridge = nil
	}
	_ = sudoRun(ctx, "nft", "delete", "table", "inet", guard.table+"_dns")
	_ = sudoRun(ctx, "nft", "delete", "table", "inet", guard.table)
	_ = sudoRun(ctx, "rmdir", guard.cgroup)
	return nil
}

// linuxDescendants returns the current process tree below root by reading
// /proc/<pid>/stat. Assigning only the root PID to a cgroup does not move
// children that already exist, so they must be added explicitly at attach time.
func linuxDescendants(root int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	children := make(map[int][]int)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if err != nil {
			continue
		}
		text := string(data)
		end := strings.LastIndex(text, ")")
		if end < 0 {
			continue
		}
		fields := strings.Fields(text[end+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}
	var out []int
	queue := []int{root}
	seen := map[int]struct{}{root: {}}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		for _, child := range children[parent] {
			if _, exists := seen[child]; exists {
				continue
			}
			seen[child] = struct{}{}
			queue = append(queue, child)
			out = append(out, child)
		}
	}
	return out
}

func (guard *LinuxGuard) Status() GuardStatus {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	return GuardStatus{Active: guard.started, Mode: ModeStrict, Backend: "cgroup+nftables", ProtectedPIDs: guard.protected}
}

func (guard *LinuxGuard) Audit(context.Context) (Audit, error) {
	return Audit{DNSMode: guard.options.Policy.DNS, Notes: []string{"cgroup v2 output chain drops non-loopback traffic"}}, nil
}

func sudoRun(ctx context.Context, name string, args ...string) error {
	command := exec.CommandContext(ctx, "sudo", append([]string{"-n", name}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message != "" {
			return fmt.Errorf("%s: %s", err, message)
		}
		return err
	}
	return nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func sanitizeID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	for _, character := range value {
		if (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_' || character == '-' {
			builder.WriteRune(character)
		}
	}
	return builder.String()
}
