package providercliupgrade

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultCodexVerifyTimeout = 15 * time.Second

var (
	codexReadyRe        = regexp.MustCompile(`(?i)listening on:`)
	codexConfigRejectRe = regexp.MustCompile(`(?i)error loading .*config|config error|must not be empty|invalid .*config|failed to parse`)
)

// CodexVerifyOptions 配置 Codex app-server 强判据验证行为。
type CodexVerifyOptions struct {
	CLIPath        string
	ProbePort      int
	Timeout        time.Duration
	GoOS           string
	NodeExecutable string
	BaseEnv        map[string]string
}

// VerifyCodexAppServerBoot 使用隔离一次性 CODEX_HOME 沙箱拉起 `codex app-server`，
// 验证新版本能否顺利加载受管配置并进入监听状态。
func VerifyCodexAppServerBoot(ctx context.Context, opts CodexVerifyOptions) Verification {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultCodexVerifyTimeout
	}
	goos := strings.TrimSpace(opts.GoOS)
	if goos == "" {
		goos = runtime.GOOS
	}

	sandboxHome, err := os.MkdirTemp("", "aih-codex-verify-*")
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "sandbox_failed:" + err.Error()}
	}
	defer func() { _ = os.RemoveAll(sandboxHome) }()

	codexHome := filepath.Join(sandboxHome, ".codex")
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "sandbox_failed:" + err.Error()}
	}
	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("personality = \"pragmatic\"\n"), 0o600); err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "sandbox_failed:" + err.Error()}
	}
	if err := HealCodexSandboxConfig(codexHome, "http://127.0.0.1:1/v1"); err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "heal_failed:" + err.Error()}
	}

	port := opts.ProbePort
	if port < 0 {
		port = 0
	}
	args := []string{
		"app-server",
		"-c", "model_provider=aih_server",
		"-c", "model_providers.aih_server.base_url=http://127.0.0.1:1/v1",
		"-c", "model_providers.aih_server.wire_api=responses",
		"--listen", "ws://127.0.0.1:" + strconv.Itoa(port),
	}

	cliPath := strings.TrimSpace(opts.CLIPath)
	if cliPath == "" {
		cliPath = "codex"
	}

	childEnv := buildChildEnvMap(opts.BaseEnv, map[string]string{
		"CODEX_HOME":      codexHome,
		"OPENAI_API_KEY":  "aih-verify",
		"OPENAI_BASE_URL": "http://127.0.0.1:1/v1",
	})

	cmd := buildCodexVerifyCommand(cliPath, args, goos, opts.NodeExecutable)
	cmd.Env = envSliceFromMap(childEnv)
	configureVerifyCmdProcessGroup(cmd)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "spawn_failed:" + err.Error()}
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "spawn_failed:" + err.Error()}
	}
	if err := cmd.Start(); err != nil {
		return Verification{Verdict: VerdictInconclusive, Detail: "spawn_failed:" + err.Error()}
	}

	type lineEvent struct {
		line string
	}
	linesCh := make(chan lineEvent, 64)
	var readWG sync.WaitGroup
	readPipe := func(pipe io.ReadCloser) {
		defer readWG.Done()
		scanner := bufio.NewScanner(pipe)
		buf := make([]byte, 64*1024)
		scanner.Buffer(buf, 512*1024)
		for scanner.Scan() {
			linesCh <- lineEvent{line: scanner.Text()}
		}
	}
	readWG.Add(2)
	go readPipe(stdoutPipe)
	go readPipe(stderrPipe)

	waitDone := make(chan error, 1)
	go func() {
		readWG.Wait()
		close(linesCh)
		waitDone <- cmd.Wait()
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	var outputLines []string
	var processExited bool
	drainAndKill := func() {
		killVerifyCmdProcessTree(cmd)
		if !processExited {
			select {
			case <-waitDone:
			case <-time.After(500 * time.Millisecond):
			}
		}
	}

	for {
		select {
		case ev, ok := <-linesCh:
			if !ok {
				linesCh = nil
				continue
			}
			outputLines = append(outputLines, ev.line)
			if codexReadyRe.MatchString(ev.line) {
				drainAndKill()
				return Verification{Verdict: VerdictPass, Detail: "app_server_listening"}
			}
		case <-waitDone:
			processExited = true
			if linesCh != nil {
				for ev := range linesCh {
					outputLines = append(outputLines, ev.line)
					if codexReadyRe.MatchString(ev.line) {
						return Verification{Verdict: VerdictPass, Detail: "app_server_listening"}
					}
				}
			}
			for _, line := range outputLines {
				if codexConfigRejectRe.MatchString(line) {
					detail := strings.TrimSpace(line)
					if len(detail) > 300 {
						detail = detail[:300]
					}
					return Verification{Verdict: VerdictFail, Detail: detail}
				}
			}
			return Verification{Verdict: VerdictInconclusive, Detail: "exited_without_signature"}
		case <-timer.C:
			drainAndKill()
			for _, line := range outputLines {
				if codexReadyRe.MatchString(line) {
					return Verification{Verdict: VerdictPass, Detail: "app_server_listening"}
				}
			}
			return Verification{Verdict: VerdictInconclusive, Detail: "timeout_without_exit"}
		case <-ctx.Done():
			drainAndKill()
			return Verification{Verdict: VerdictInconclusive, Detail: fmt.Sprintf("context_canceled:%v", ctx.Err())}
		}
	}
}

func buildCodexVerifyCommand(cliPath string, args []string, goos string, nodeExec string) *exec.Cmd {
	// 与 Node resolveWindowsUpstreamSpawn 同口径：Windows 下若是 npm .cmd 垫片直接绕开。
	if isWindowsOS(goos) && cmdOrBatExtRe.MatchString(cliPath) {
		if shimTarget := followNpmCmdShim(cliPath); shimTarget != "" && jsScriptExtRe.MatchString(shimTarget) {
			nodeBin := strings.TrimSpace(nodeExec)
			if nodeBin == "" {
				nodeBin = "node"
			}
			fullArgs := append([]string{shimTarget}, args...)
			return exec.Command(nodeBin, fullArgs...)
		}
		if aihTarget := followAIHShim(cliPath); aihTarget != "" {
			cliPath = aihTarget
		}
	}
	return exec.Command(cliPath, args...)
}
