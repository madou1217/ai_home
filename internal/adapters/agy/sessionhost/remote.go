package sessionhost

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

// 远端自持模式：agy 跑在远端 tmux 会话里，输入/输出落在远端的行式文件。
// 本地进程只是「客户端」：追加一行输入、按字节偏移跟随输出。
// 因此本地 Server 重启（或 SSH 断开）不会杀掉远端 agy，在途回合的结果仍留在
// out.ndjson 里，重启后按 offset 继续消费即可。

const (
	remoteSessionRoot     = "$HOME/.ai_home/run/agy-sessions"
	remoteReadRetryDelay  = 2 * time.Second
	remoteStatusProbeTTL  = 15 * time.Second
	remoteMaxLineScanSize = defaultLineLimit
)

type remoteSession struct {
	spec    Spec
	dir     string // 远端会话目录（shell 表达式，含 $HOME）
	socket  string // tmux socket 名
	control string // ssh ControlMaster 的 socket 路径（本地）

	mu       sync.Mutex
	alive    bool
	offset   int64
	reader   context.CancelFunc
	probedAt time.Time
	home     string // 远端真实家目录（绝对路径，避免 $HOME 在引号里不展开）
}

// remoteSSHArgs 复用 sshhost 的引用规则；额外加 ControlMaster 让「写一行/读一次」
// 这类小命令复用同一条连接，避免每次握手。
func (remote *remoteSession) sshArgs(command string) []string {
	transport := *remote.spec.SSH
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ServerAliveInterval=10",
		"-o", "ServerAliveCountMax=18",
		"-o", "TCPKeepAlive=yes",
		"-o", "ControlMaster=auto",
		"-o", "ControlPath=" + remote.control,
		"-o", "ControlPersist=300",
	}
	if identity := strings.TrimSpace(transport.IdentityFile); identity != "" {
		args = append(args, "-i", identity)
	}
	if transport.Port != 0 {
		args = append(args, "-p", strconv.Itoa(transport.Port))
	}
	destination := transport.Host
	if strings.TrimSpace(transport.User) != "" {
		destination = transport.User + "@" + transport.Host
	}
	return append(args, destination, command)
}

// runRemote 执行一条远端命令；stdin 为 nil 时从 /dev/null 读。
func (remote *remoteSession) runRemote(ctx context.Context, stdin io.Reader, command string) (string, error) {
	cmd := exec.CommandContext(ctx, "ssh", remote.sshArgs(command)...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	output, err := cmd.CombinedOutput()
	return string(output), err
}

func (remote *remoteSession) dirName() string {
	remote.mu.Lock()
	home := remote.home
	remote.mu.Unlock()
	if home == "" {
		// 未解析前退回远端 $HOME（仅在命令行未加引号时安全）；正常路径都会先 ensureHome。
		return fmt.Sprintf("%s/%s", remoteSessionRoot, remote.spec.SessionID)
	}
	return path.Join(home, ".ai_home", "run", "agy-sessions", remote.spec.SessionID)
}

// ensureHome 解析远端真实家目录并缓存；所有文件路径都用绝对路径。
func (remote *remoteSession) ensureHome(ctx context.Context) (string, error) {
	remote.mu.Lock()
	home := remote.home
	remote.mu.Unlock()
	if home != "" {
		return home, nil
	}
	output, err := remote.runRemote(ctx, nil, `sh -c 'printf %s "$HOME"'`)
	if err != nil {
		return "", fmt.Errorf("agy_remote_home: %w", err)
	}
	home = strings.TrimSpace(output)
	if home == "" || !strings.HasPrefix(home, "/") {
		return "", fmt.Errorf("agy_remote_home_invalid")
	}
	remote.mu.Lock()
	remote.home = home
	remote.mu.Unlock()
	return home, nil
}

// startPipeline 在远端拉起「tail 输入 → agy → 输出」的常驻管道。
// 已在跑时不重启；reuse=true 时按 conversation 续接。
func (remote *remoteSession) startPipeline(ctx context.Context, conversation string) error {
	if _, err := remote.ensureHome(ctx); err != nil {
		return err
	}
	dir := remote.dirName()
	argv := buildAGYArgs(remote.spec, conversation)
	quoted := make([]string, 0, len(argv))
	for _, arg := range argv {
		quoted = append(quoted, sshhost.ShellQuote(arg))
	}
	binary := strings.TrimSpace(remote.spec.Binary)
	if binary == "" {
		binary = "$HOME/.local/bin/agy"
	}
	// HOME 前缀只作用于 agy 本身（tail 不关心）；数据目录始终在远端真实家目录下。
	envPrefix := ""
	if accountHome := strings.TrimSpace(remote.spec.HomeDir); accountHome != "" {
		envPrefix = "HOME=" + sshhost.ShellQuote(accountHome) + " "
	}
	// -n +1：从文件开头读；输入文件在启动时被截断，所以不会重放历史提示。
	pipeline := "tail -f -n +1 " + sshhost.ShellQuote(dir+"/in.ndjson")
	pipeline += " | " + envPrefix + binary
	if len(quoted) > 0 {
		pipeline += " " + strings.Join(quoted, " ")
	}
	pipeline += " >> " + sshhost.ShellQuote(dir+"/out.ndjson")
	pipeline += " 2>> " + sshhost.ShellQuote(dir+"/err.log")
	// 诊断：记录管道退出码与时间，便于定位“启动后立刻消失”。
	pipeline = "{ " + pipeline + " ; rc=$?; echo \"$(date +%T) exit=$rc home=$HOME\" >> " + sshhost.ShellQuote(dir+"/runner.log") + " ; }"
	if workDir := strings.TrimSpace(remote.spec.WorkDir); workDir != "" {
		pipeline = "cd " + sshhost.ShellQuote(workDir) + " && " + pipeline
	}
	script := strings.Join([]string{
		"set -u",
		"mkdir -p " + sshhost.ShellQuote(dir),
		": >> " + sshhost.ShellQuote(dir+"/out.ndjson"),
		// 必须存在且为空：tail -f 打开不存在的文件会立刻退出（agy 读到 EOF 就结束）；
		// 截断保证重启时不会重放已经执行过的提示。
		": > " + sshhost.ShellQuote(dir+"/in.ndjson"),
		// 先尝试 tmux（可观测、可 kill）；没有 tmux 时退回 setsid，进程同样脱离 SSH。
		"if command -v tmux >/dev/null 2>&1; then",
		"  tmux -L " + sshhost.ShellQuote(remote.socket) + " kill-session -t =web 2>/dev/null || true",
		"  tmux -L " + sshhost.ShellQuote(remote.socket) + " new-session -d -s web " + sshhost.ShellQuote(pipeline),
		"else",
		"  setsid nohup sh -c " + sshhost.ShellQuote(pipeline) + " >/dev/null 2>&1 </dev/null &",
		"fi",
	}, "\n")
	if os.Getenv("AIH_AGY_DEBUG") != "" {
		_ = os.WriteFile("/tmp/agy-remote-debug.txt", []byte(script), 0o644)
	}
	output, err := remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(script))
	if err != nil {
		return fmt.Errorf("agy_remote_start: %v %s", err, truncate(strings.TrimSpace(output), 300))
	}
	return nil
}

// aliveRemote 判断远端管道是否还在跑。
func (remote *remoteSession) aliveRemote(ctx context.Context) bool {
	if _, err := remote.ensureHome(ctx); err != nil {
		return false
	}
	dir := remote.dirName()
	script := strings.Join([]string{
		"if command -v tmux >/dev/null 2>&1; then",
		"  tmux -L " + sshhost.ShellQuote(remote.socket) + " has-session -t =web 2>/dev/null && exit 0",
		"fi",
		// 必须锚定 tail 进程本身：脚本文本里也含这个路径，裸 pgrep -f 会匹配到执行探测的 shell 自己。
		"pgrep -f " + sshhost.ShellQuote("^tail -f -n 0 "+dir+"/in.ndjson") + " >/dev/null 2>&1 && exit 0",
		"exit 1",
	}, "\n")
	_, err := remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(script))
	return err == nil
}

// writeTurn 把一轮用户输入追加到远端输入文件。
func (remote *remoteSession) writeTurn(ctx context.Context, line string) error {
	if _, err := remote.ensureHome(ctx); err != nil {
		return err
	}
	dir := remote.dirName()
	_, err := remote.runRemote(ctx, strings.NewReader(line),
		"sh -c "+sshhost.ShellQuote("cat >> "+sshhost.ShellQuote(dir+"/in.ndjson")))
	if err != nil {
		return fmt.Errorf("agy_remote_write: %w", err)
	}
	return nil
}

// follow 从 offset 起持续跟随 out.ndjson；连接断开后自动重连。
// 每次拿到一行就交给 consume，字节偏移按实际读到的行推进。
func (remote *remoteSession) follow(ctx context.Context, offset int64, consume func(string), onExit func(error)) {
	if _, err := remote.ensureHome(ctx); err != nil {
		onExit(err)
		return
	}
	dir := remote.dirName()
	current := offset
	for {
		if ctx.Err() != nil {
			return
		}
		command := "sh -c " + sshhost.ShellQuote(
			"tail -f -c +"+strconv.FormatInt(current+1, 10)+" "+sshhost.ShellQuote(dir+"/out.ndjson"),
		)
		cmd := exec.CommandContext(ctx, "ssh", remote.sshArgs(command)...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			onExit(err)
			return
		}
		cmd.Stderr = io.Discard
		if err := cmd.Start(); err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(remoteReadRetryDelay):
			}
			continue
		}
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1<<20), remoteMaxLineScanSize)
		for scanner.Scan() {
			line := scanner.Text()
			consume(line)
			current += int64(len(line)) + 1
			remote.mu.Lock()
			remote.offset = current
			remote.mu.Unlock()
		}
		_ = cmd.Wait()
		select {
		case <-ctx.Done():
			return
		case <-time.After(remoteReadRetryDelay):
		}
	}
}

// killRemote 结束远端管道（用户显式 close 时才调用）。
func (remote *remoteSession) killRemote(ctx context.Context) {
	if _, err := remote.ensureHome(ctx); err != nil {
		return
	}
	dir := remote.dirName()
	script := strings.Join([]string{
		"tmux -L " + sshhost.ShellQuote(remote.socket) + " kill-session -t =web 2>/dev/null || true",
		"pkill -f " + sshhost.ShellQuote("^tail -f -n 0 "+dir+"/in.ndjson") + " 2>/dev/null || true",
	}, "\n")
	_, _ = remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(script))
}

func newRemoteSession(spec Spec) *remoteSession {
	short := spec.SessionID
	if len(short) > 40 {
		short = short[:40]
	}
	controlPath := path.Join(os.TempDir(), "aih-agy-"+short+".sock")
	return &remoteSession{
		spec:    spec,
		dir:     fmt.Sprintf("%s/%s", remoteSessionRoot, spec.SessionID),
		socket:  "aih-agy-" + short,
		control: controlPath,
	}
}

var errRemoteUnavailable = errors.New("agy_remote_unavailable")

func isRemoteSpec(spec Spec) bool {
	return spec.SSH != nil && strings.TrimSpace(spec.SessionID) != ""
}
