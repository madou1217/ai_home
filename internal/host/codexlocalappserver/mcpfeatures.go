package codexlocalappserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const (
	// mcpFeatureLazy 让多个线程复用同一组 stdio MCP 连接（实测需与 sharing 一起使用）。
	mcpFeatureLazy = "mcp_lazy_stdio_startup"
	// mcpFeatureSharing 是官方声明的连接共享开关；单独开启实测不收敛。
	mcpFeatureSharing = "mcp_connection_sharing"

	featureProbeTimeout = 8 * time.Second
	warmSettleFor       = 900 * time.Millisecond
	warmMaxWait         = 9 * time.Second
	featureCacheVersion = 1
)

type mcpFeatureSupport struct {
	Version int  `json:"version"`
	Lazy    bool `json:"lazy"`
	Sharing bool `json:"sharing"`
}

// usable 表示这套开关能否真正收敛 MCP：只有 lazy 生效，sharing 单独开启无效。
func (s mcpFeatureSupport) usable() bool { return s.Lazy }

// withSharedMCPFeatures 在启动参数里追加官方 MCP 复用开关。
// 探测结果按二进制指纹缓存，避免每次启动都拉起一次 features list。
func withSharedMCPFeatures(ctx context.Context, root string, command string, args []string, env []string) []string {
	support := resolveMCPFeatureSupport(ctx, root, command, env)
	if !support.usable() {
		return args
	}
	out := make([]string, 0, len(args)+4)
	out = append(out, args...)
	out = append(out, "-c", "features."+mcpFeatureLazy+"=true")
	if support.Sharing {
		out = append(out, "-c", "features."+mcpFeatureSharing+"=true")
	}
	return out
}

func resolveMCPFeatureSupport(ctx context.Context, root, command string, env []string) mcpFeatureSupport {
	if strings.TrimSpace(command) == "" {
		return mcpFeatureSupport{}
	}
	cachePath := featureCachePath(root, command)
	if cached, ok := readFeatureCache(cachePath); ok {
		return cached
	}
	support, probed := probeMCPFeatureSupport(ctx, command, env)
	if !probed {
		// 探测失败不写缓存：偶发超时不能把某个版本永久判成不支持。
		return support
	}
	support.Version = featureCacheVersion
	if payload, err := json.Marshal(support); err == nil {
		_ = os.MkdirAll(root, 0o755)
		temp := cachePath + ".tmp" + strconv.Itoa(os.Getpid())
		if err = os.WriteFile(temp, payload, 0o600); err == nil {
			_ = os.Rename(temp, cachePath)
		}
	}
	return support
}

func featureCachePath(root, command string) string {
	signature := command
	if info, err := os.Stat(command); err == nil {
		signature += "|" + info.ModTime().UTC().String() + "|" + strconv.FormatInt(info.Size(), 10)
	}
	sum := sha256.Sum256([]byte(signature))
	return filepath.Join(root, ".features-"+hex.EncodeToString(sum[:8])+".json")
}

func readFeatureCache(path string) (mcpFeatureSupport, bool) {
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		return mcpFeatureSupport{}, false
	}
	var support mcpFeatureSupport
	if json.Unmarshal(raw, &support) != nil || support.Version != featureCacheVersion {
		return mcpFeatureSupport{}, false
	}
	return support, true
}

// probeMCPFeatureSupport 读取官方特性清单；只有明确支持 lazy 才启用这套复用。
func probeMCPFeatureSupport(ctx context.Context, command string, env []string) (mcpFeatureSupport, bool) {
	probeCtx, cancel := context.WithTimeout(ctx, featureProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, command, "features", "list")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return mcpFeatureSupport{}, false
	}
	support := mcpFeatureSupport{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		stage := strings.ToLower(fields[len(fields)-2])
		switch fields[0] {
		case mcpFeatureLazy:
			support.Lazy = stage != "removed"
		case mcpFeatureSharing:
			support.Sharing = stage != "removed"
		}
	}
	return support, true
}

// warmSharedBackend 用一条 ephemeral 线程把 MCP 连接先建起来。
// 官方共享实现存在首启竞态：并发的首个线程会各拉一套 MCP，
// 先建好连接后其它终端（包括并发启动）都会复用同一组。
func warmSharedBackend(ctx context.Context, pid int, url, cwd string) {
	warmCtx, cancel := context.WithTimeout(ctx, warmMaxWait)
	defer cancel()
	session, err := codexappserverws.DialSharedBackend(warmCtx, url, 0)
	if err != nil {
		return
	}
	defer session.Close()
	if !writeWarmFrame(warmCtx, session, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{"clientInfo": map[string]string{"name": "aih-mcp-warmup", "version": "1"}},
	}) {
		return
	}
	if _, ok := readWarmFrame(warmCtx, session); !ok {
		return
	}
	if !writeWarmFrame(warmCtx, session, map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "thread/start",
		"params": map[string]any{"cwd": cwd, "ephemeral": true},
	}) {
		return
	}
	waitForMCPWarm(warmCtx, pid)
}

// waitForMCPWarm 等 MCP 子进程数量稳定，说明各 server 的连接都已建立。
func waitForMCPWarm(ctx context.Context, pid int) {
	if runtime.GOOS == "windows" {
		select {
		case <-ctx.Done():
		case <-time.After(3 * time.Second):
		}
		return
	}
	last := -1
	stableSince := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(150 * time.Millisecond):
		}
		count := countMCPDescendants(pid)
		if count != last {
			last = count
			stableSince = time.Now()
			continue
		}
		if count > 0 && time.Since(stableSince) >= warmSettleFor {
			return
		}
		if count == 0 && time.Since(stableSince) >= 3*time.Second {
			return
		}
	}
}

func writeWarmFrame(ctx context.Context, session *codexappserverws.BackendSession, payload map[string]any) bool {
	raw, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	if _, err = session.Stdin.Write(raw); err != nil {
		return false
	}
	if _, err = session.Stdin.Write([]byte("\n")); err != nil {
		return false
	}
	return ctx.Err() == nil
}

func readWarmFrame(ctx context.Context, session *codexappserverws.BackendSession) ([]byte, bool) {
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() {
		buffer := make([]byte, 64<<10)
		n, err := session.Stdout.Read(buffer)
		done <- result{buffer[:n], err}
	}()
	select {
	case <-ctx.Done():
		return nil, false
	case out := <-done:
		if out.err != nil {
			return nil, false
		}
		return out.data, true
	}
}

// countMCPDescendants 统计后端进程下形如 MCP server 的子进程数量。
func countMCPDescendants(rootPID int) int {
	out, err := exec.Command("ps", "-Ao", "pid,ppid,command").Output()
	if err != nil {
		return 0
	}
	children := map[int][]int{}
	commands := map[int]string{}
	for _, line := range strings.Split(string(out), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		children[ppid] = append(children[ppid], pid)
		commands[pid] = strings.ToLower(strings.Join(fields[2:], " "))
	}
	count := 0
	seen := map[int]bool{}
	stack := append([]int{}, children[rootPID]...)
	for len(stack) > 0 {
		pid := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		stack = append(stack, children[pid]...)
		command := commands[pid]
		if strings.Contains(command, "mcp") || strings.Contains(command, "cua-repl") || strings.Contains(command, "xcodebuild") {
			count++
		}
	}
	return count
}
