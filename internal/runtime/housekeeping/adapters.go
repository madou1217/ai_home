package housekeeping

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

const defaultCommandTimeout = 5 * time.Second

var appServerCommandPattern = regexp.MustCompile(`\bapp-server\b`)

// SQLiteRegisteredAccountsReader 通过 sqliteaccount.Store 分页读取全部权威账号记录。
type SQLiteRegisteredAccountsReader struct {
	Store *sqliteaccount.Store
}

// ListRegisteredAccounts 遍历账号库并返回全量账号快照。
func (reader SQLiteRegisteredAccountsReader) ListRegisteredAccounts(
	ctx context.Context,
) ([]RegisteredAccount, error) {
	if reader.Store == nil {
		return nil, ErrInvalidOptions
	}
	var afterRef accountcore.AccountRef
	results := make([]RegisteredAccount, 0, 32)
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		page, err := reader.Store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		for _, overview := range page {
			account := overview.Account()
			status := "down"
			if account.Enabled() {
				status = "up"
			}
			results = append(results, RegisteredAccount{
				Provider:   account.ProviderID(),
				AccountRef: account.Ref().String(),
				Status:     status,
				Enabled:    account.Enabled(),
			})
		}
		if len(page) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = page[len(page)-1].Account().Ref()
	}
	return results, nil
}

// DeletionProjectionReconciler 将陈旧投影对账委托给 deletionprojection。
type DeletionProjectionReconciler struct {
	AIHomeDir   string
	HostHomeDir string
}

// Reconcile 在删掉陈旧投影前先将未同步的宿主资源安全迁移回 HostHomeDir。
func (reconciler DeletionProjectionReconciler) Reconcile(
	ctx context.Context,
	provider string,
	_ string,
	rootKind string,
	projectionPath string,
) error {
	return deletionprojection.ReconcileStaleProjectionRoot(
		ctx,
		reconciler.AIHomeDir,
		reconciler.HostHomeDir,
		provider,
		rootKind,
		projectionPath,
	)
}

// OSCommandRunner 使用标准库 os/exec 执行系统命令探测或进程清理。
type OSCommandRunner struct {
	Timeout time.Duration
}

// Run 执行命令并收集 stdout、stderr 与退出码。
func (runner OSCommandRunner) Run(
	ctx context.Context,
	name string,
	args ...string,
) (string, string, int, error) {
	timeout := runner.Timeout
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, name, args...)
	configureHiddenWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

// OSCodexEndpointInvalidator 使用注入或系统命令执行 tmux/herdr 会话关闭与端口宿主进程清理。
type OSCodexEndpointInvalidator struct {
	Runner   CommandRunner
	Platform string
	Env      func(string) string
	UID      func() int
	KillPID  func(pid int) error
}

// Invalidate 严格校验 multiplexer 与 socket 名，关闭 mux 会话并终止残留端口进程，然后删 state JSON。
func (invalidator OSCodexEndpointInvalidator) Invalidate(
	ctx context.Context,
	target CodexAppServerTarget,
) error {
	if ctx == nil || strings.TrimSpace(target.RuntimeScope) == "" || strings.TrimSpace(target.StatePath) == "" {
		return ErrInvalidOptions
	}
	backend := strings.ToLower(strings.TrimSpace(target.Multiplexer))
	if backend == "" {
		backend = "tmux"
	} else if backend != "tmux" && backend != "herdr" {
		return fmt.Errorf("codex app-server backend state 非法，拒绝清理未知 driver: %s", backend)
	}

	expectedSocket := AppServerSocketName(target.RuntimeScope)
	storedSocket := strings.TrimSpace(target.Socket)
	if storedSocket == "" {
		storedSocket = expectedSocket
	}
	if storedSocket != expectedSocket {
		return fmt.Errorf("codex app-server socket 与账号 runtime scope 不匹配")
	}

	runner := invalidator.runner()
	platform := invalidator.platform()
	getenv := invalidator.getenv()

	if strings.TrimSpace(getenv("AIH_NO_PERSIST")) == "1" {
		return fmt.Errorf("codex app-server 的 %s backend 已禁用，无法安全失效账号进程", backend)
	}

	cmdPath, available := detectMultiplexerCommand(ctx, runner, platform, backend)
	if !available {
		return fmt.Errorf("codex app-server 的 %s backend 不可用，无法安全失效账号进程", backend)
	}

	switch backend {
	case "tmux":
		_, _, _, _ = runner.Run(ctx, cmdPath, "-L", storedSocket, "kill-server")
		if platform != "windows" {
			_ = os.Remove(tmuxRunSocketPath(storedSocket, getenv, invalidator.uid()))
		}
	case "herdr":
		_, _, _, _ = runner.Run(ctx, cmdPath, "kill", "--session", storedSocket+"-run")
	}

	if target.Port > 0 && target.Port <= 65535 {
		invalidator.killAppServerPortOwner(ctx, runner, platform, target.Port)
	}

	if hasActiveRunSession(ctx, runner, backend, cmdPath, storedSocket) {
		return errors.New("Codex app-server 账号进程仍在运行，保留 runtime state 以便重试")
	}

	if err := os.Remove(target.StatePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("codex app-server 已停止，但 runtime state 清理失败: %w", err)
	}
	return nil
}

func (invalidator OSCodexEndpointInvalidator) runner() CommandRunner {
	if invalidator.Runner != nil {
		return invalidator.Runner
	}
	return OSCommandRunner{}
}

func (invalidator OSCodexEndpointInvalidator) platform() string {
	if p := strings.TrimSpace(invalidator.Platform); p != "" {
		return strings.ToLower(p)
	}
	return runtime.GOOS
}

func (invalidator OSCodexEndpointInvalidator) getenv() func(string) string {
	if invalidator.Env != nil {
		return invalidator.Env
	}
	return os.Getenv
}

func (invalidator OSCodexEndpointInvalidator) uid() int {
	if invalidator.UID != nil {
		return invalidator.UID()
	}
	return os.Getuid()
}

func (invalidator OSCodexEndpointInvalidator) killAppServerPortOwner(
	ctx context.Context,
	runner CommandRunner,
	platform string,
	port int,
) {
	if platform == "windows" {
		stdout, _, code, err := runner.Run(ctx, "netstat", "-ano")
		if err != nil || code != 0 || stdout == "" {
			return
		}
		seen := make(map[int]struct{})
		suffix := ":" + strconv.Itoa(port)
		for _, line := range strings.Split(stdout, "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 5 &&
				strings.EqualFold(fields[0], "TCP") &&
				strings.HasSuffix(fields[1], suffix) &&
				strings.Contains(strings.ToUpper(fields[3]), "LISTEN") {
				pid, convErr := strconv.Atoi(fields[4])
				if convErr == nil && pid > 0 {
					seen[pid] = struct{}{}
				}
			}
		}
		for pid := range seen {
			_, _, _, _ = runner.Run(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
		}
		return
	}

	stdout, _, code, err := runner.Run(ctx, "lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN", "-t")
	if (err != nil && code != 0) || strings.TrimSpace(stdout) == "" {
		return
	}
	killFn := invalidator.KillPID
	if killFn == nil {
		killFn = terminatePID
	}
	selfPID := os.Getpid()
	portBind := fmt.Sprintf("127.0.0.1:%d", port)
	for _, token := range strings.Fields(stdout) {
		pid, convErr := strconv.Atoi(token)
		if convErr != nil || pid <= 1 || pid == selfPID {
			continue
		}
		psOut, _, _, _ := runner.Run(ctx, "ps", "-o", "command=", "-p", strconv.Itoa(pid))
		if !appServerCommandPattern.MatchString(psOut) || !strings.Contains(psOut, portBind) {
			continue
		}
		_ = killFn(pid)
	}
}

func detectMultiplexerCommand(
	ctx context.Context,
	runner CommandRunner,
	platform string,
	backend string,
) (string, bool) {
	if backend == "herdr" {
		outStdout, outStderr, code, err := runner.Run(ctx, "herdr", "--help")
		help := outStdout + "\n" + outStderr
		if err == nil && code == 0 && strings.Contains(help, "spawn") && strings.Contains(help, "--session") {
			return "herdr", true
		}
		return "", false
	}

	candidates := []string{"tmux"}
	if platform == "windows" {
		candidates = []string{
			"psmux",
			"tmux",
			`C:\msys64\usr\bin\tmux.exe`,
			`C:\cygwin64\bin\tmux.exe`,
		}
	}
	for _, candidate := range candidates {
		_, _, code, err := runner.Run(ctx, candidate, "-V")
		if err == nil && code == 0 {
			return candidate, true
		}
	}
	return "", false
}

func hasActiveRunSession(
	ctx context.Context,
	runner CommandRunner,
	backend string,
	cmdPath string,
	socket string,
) bool {
	if backend == "herdr" {
		_, _, code, err := runner.Run(ctx, cmdPath, "status", "--session", socket+"-run")
		return err == nil && code == 0
	}
	_, _, code, err := runner.Run(ctx, cmdPath, "-L", socket, "has-session", "-t", "run")
	return err == nil && code == 0
}

func tmuxRunSocketPath(socket string, getenv func(string) string, uid int) string {
	base := strings.TrimSpace(getenv("TMUX_TMPDIR"))
	if base == "" {
		base = "/tmp"
	}
	return filepath.Join(base, fmt.Sprintf("tmux-%d", uid), socket)
}
