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
	started := time.Now()
	cmd := exec.CommandContext(ctx, "ssh", remote.sshArgs(command)...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	output, err := cmd.CombinedOutput()
	if file, fileErr := os.OpenFile(os.ExpandEnv("$HOME/.ai_home/run/agy-remote.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); fileErr == nil {
		fmt.Fprintf(file, "%s %6dms %s err=%v\n", remote.spec.SessionID, time.Since(started).Milliseconds(), truncate(command, 110), err)
		_ = file.Close()
	}
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

// ensureScripts 把启动逻辑落到远端：meta.json（审计）+ start.sh（唯一启动真源）。
// 本地调用与主机重启后的 systemd 自启都执行同一个 start.sh。
func (remote *remoteSession) ensureScripts(ctx context.Context, conversation string) (string, error) {
	if _, err := remote.ensureHome(ctx); err != nil {
		return "", err
	}
	dir := remote.dirName()
	argv := buildAGYArgs(remote.spec, conversation)
	quoted := make([]string, 0, len(argv))
	for _, arg := range argv {
		quoted = append(quoted, "'"+strings.ReplaceAll(arg, "'", `'\''`)+"'")
	}
	binary := strings.TrimSpace(remote.spec.Binary)
	if binary == "" {
		binary = "$HOME/.local/bin/agy"
	}
	acctHome := strings.TrimSpace(remote.spec.HomeDir)
	workDir := strings.TrimSpace(remote.spec.WorkDir)
	meta := fmt.Sprintf(
		"{\"sessionId\":%q,\"model\":%q,\"effort\":%q,\"conversationId\":%q,\"workDir\":%q,\"accountHome\":%q,\"socket\":%q}\n",
		remote.spec.SessionID, remote.spec.Model, remote.spec.Effort, conversation, workDir, acctHome, remote.socket,
	)
	q := func(value string) string { return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'" }
	homePrefix := ""
	if acctHome != "" {
		homePrefix = "HOME=" + q(acctHome) + " "
	}
	pipeline := "tail -f -n +1 " + q(dir+"/in.ndjson")
	pipeline += " | " + homePrefix + binary
	if len(quoted) > 0 {
		pipeline += " " + strings.Join(quoted, " ")
	}
	pipeline += " >> " + q(dir+"/out.ndjson")
	pipeline += " 2>> " + q(dir+"/err.log")
	pipeline = "{ " + pipeline + " ; rc=$?; echo \"$(date +%F_%T) exit=$rc\" >> " + q(dir+"/runner.log") + " ; }"
	if workDir != "" {
		pipeline = "cd " + q(workDir) + " && " + pipeline
	}
	script := strings.Join([]string{
		"#!/bin/sh",
		"# 由 AIH 生成：远端 agy 会话启动脚本。参数 boot 表示主机/服务重启后自启。",
		"set -u",
		"D=" + q(dir),
		`[ -f "$D/meta.json" ] || exit 0`,
		`[ -f "$D/closed" ] && exit 0`,
		`if [ "${1:-}" = "boot" ]; then date +%s%3N > "$D/boot.at" 2>/dev/null || date +%s > "$D/boot.at"; fi`,
		// 输出超过 32MB 在启动点轮转，避免长期会话写满磁盘。
		`if [ -f "$D/out.ndjson" ] && [ "$(stat -c %s "$D/out.ndjson" 2>/dev/null || echo 0)" -gt 33554432 ]; then mv "$D/out.ndjson" "$D/out.ndjson.$(date +%s)"; echo ROTATED; fi`,
		`: >> "$D/out.ndjson"`,
		// 必须存在且为空：tail -f 打开不存在的文件会立刻退出；截断避免重放旧提示。
		`: > "$D/in.ndjson"`,
		"PIPE=" + q(pipeline),
		"if command -v tmux >/dev/null 2>&1; then",
		"  tmux -L " + q(remote.socket) + " kill-session -t =web 2>/dev/null || true",
		`  tmux -L ` + q(remote.socket) + ` new-session -d -s web "$PIPE"`,
		"else",
		`  setsid nohup sh -c "$PIPE" >/dev/null 2>&1 </dev/null &`,
		"fi",
		"",
	}, "\n")

	// 上传 meta.json 与 start.sh（先写临时名再 mv，避免读到半个脚本）。
	if _, err := remote.runRemote(ctx, strings.NewReader(meta),
		"sh -c "+sshhost.ShellQuote("mkdir -p "+q(dir)+" && rm -f "+q(dir+"/closed")+" && cat > "+q(dir+"/meta.json"))); err != nil {
		return "", fmt.Errorf("agy_remote_meta: %w", err)
	}
	if _, err := remote.runRemote(ctx, strings.NewReader(script),
		"sh -c "+sshhost.ShellQuote("cat > "+q(dir+"/start.sh.tmp")+" && chmod 700 "+q(dir+"/start.sh.tmp")+" && mv -f "+q(dir+"/start.sh.tmp")+" "+q(dir+"/start.sh"))); err != nil {
		return "", fmt.Errorf("agy_remote_script: %w", err)
	}
	return dir, nil
}

// ensureSupervisor 安装一次性的 systemd user 自启单元（仅 systemd 主机）。
// 不在 systemd 主机上静默跳过：会话仍可在下一次交互时由本地重新拉起。
func (remote *remoteSession) ensureSupervisor(ctx context.Context) {
	if _, err := remote.ensureHome(ctx); err != nil {
		return
	}
	unit := strings.Join([]string{
		"[Unit]",
		"Description=AIH AGY session supervisor (boot)",
		"After=default.target",
		"",
		"[Service]",
		"Type=oneshot",
		// 关闭/删除的会话带 closed 标记：即便目录里残留旧版 start.sh 也不能被复活。
		`ExecStart=/bin/sh -c 'for d in %h/.ai_home/run/agy-sessions/*/; do [ -f "$d/closed" ] && continue; [ -f "$d/start.sh" ] && sh "$d/start.sh" boot; done'`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	}, "\n")
	script := strings.Join([]string{
		"[ -d /run/systemd/system ] || exit 0",
		"command -v systemctl >/dev/null 2>&1 || exit 0",
		"mkdir -p ~/.config/systemd/user",
		"cat > ~/.config/systemd/user/aih-agy-supervisor.service <<'AIH_UNIT_EOF'",
		unit,
		"AIH_UNIT_EOF",
		"systemctl --user daemon-reload >/dev/null 2>&1 || exit 0",
		"systemctl --user enable aih-agy-supervisor.service >/dev/null 2>&1 || true",
		// 保持 linger，保证主机重启后用户单元会被拉起。
		"command -v loginctl >/dev/null 2>&1 && sudo -n loginctl enable-linger \"$USER\" >/dev/null 2>&1 || true",
	}, "\n")
	_, _ = remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(script))
}

// startPipeline 在远端拉起「tail 输入 → agy → 输出」的常驻管道，返回是否发生输出轮转。
func (remote *remoteSession) startPipeline(ctx context.Context, conversation string) (bool, error) {
	dir, err := remote.ensureScripts(ctx, conversation)
	if err != nil {
		return false, err
	}
	remote.ensureSupervisor(ctx)
	output, err := remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote("sh "+sshhost.ShellQuote(dir+"/start.sh")))
	if err != nil {
		return false, fmt.Errorf("agy_remote_start: %v %s", err, truncate(strings.TrimSpace(output), 300))
	}
	return strings.Contains(output, "ROTATED"), nil
}

// aliveRemote 探测远端管道，并顺带返回最近一次 boot 标记（epoch ms）。
func (remote *remoteSession) aliveRemote(ctx context.Context) (bool, int64) {
	if _, err := remote.ensureHome(ctx); err != nil {
		return false, 0
	}
	dir := remote.dirName()
	script := strings.Join([]string{
		"D=" + sshhost.ShellQuote(dir),
		`BOOT=$(cat "$D/boot.at" 2>/dev/null || echo 0)`,
		"ALIVE=0",
		`tmux -L ` + sshhost.ShellQuote(remote.socket) + ` has-session -t =web 2>/dev/null && ALIVE=1`,
		`pgrep -f ` + sshhost.ShellQuote("^tail -f -n .*"+dir+"/in.ndjson") + ` >/dev/null 2>&1 && ALIVE=1`,
		`echo "ALIVE=$ALIVE"`,
		`echo "BOOTAT=$BOOT"`,
	}, "\n")
	output, err := remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(script))
	if err != nil {
		return false, 0
	}
	alive := strings.Contains(output, "ALIVE=1")
	var bootAt int64
	for _, line := range strings.Split(output, "\n") {
		if strings.HasPrefix(line, "BOOTAT=") {
			bootAt, _ = strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "BOOTAT=")), 10, 64)
		}
	}
	return alive, bootAt
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
	// 轮转或文件被替换后，旧偏移可能大于文件长度：越界就从头读，绝不静默丢事件。
	if sizeOutput, sizeErr := remote.runRemote(ctx, nil, "sh -c "+sshhost.ShellQuote(
		"stat -c %s "+sshhost.ShellQuote(dir+"/out.ndjson")+" 2>/dev/null || echo 0",
	)); sizeErr == nil {
		if size, convErr := strconv.ParseInt(strings.TrimSpace(sizeOutput), 10, 64); convErr == nil && current > size {
			current = 0
		}
	}
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
		"pkill -f " + sshhost.ShellQuote("^tail -f -n .*"+dir+"/in.ndjson") + " 2>/dev/null || true",
		// 标记关闭：主机重启后的自启脚本会跳过它，不会复活已关闭的会话。
		": > " + sshhost.ShellQuote(dir+"/closed"),
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
