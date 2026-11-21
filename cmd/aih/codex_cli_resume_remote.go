package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/codexappconfig"
)

const remoteResumeTokenEnv = "AIH_CODEX_REMOTE_AUTH_TOKEN"

type remoteResumeConfig struct {
	host      string
	port      int
	authToken string
}

type scopedResumeProxy struct {
	RemoteURL string
	Token     string
	command   *exec.Cmd
	stdin     interface{ Close() error }
}

func (proxy *scopedResumeProxy) Close() {
	if proxy == nil {
		return
	}
	if proxy.stdin != nil {
		_ = proxy.stdin.Close()
	}
	if proxy.command != nil && proxy.command.Process != nil {
		_ = proxy.command.Process.Kill()
		_, _ = proxy.command.Process.Wait()
	}
}

// tryRemoteResume 复刻 Node 的远程 resume 路径：仅当本地 app-server 被排除、
// 服务端可连通且账号模式允许时，把 TUI 接到 aih server 的远程 app-server。
func tryRemoteResume(
	ctx context.Context,
	upstream string,
	forward []string,
	spawnEnv []string,
	spawnMap map[string]string,
	aiHome string,
	runtime commandRuntime,
) (bool, error) {
	if !remoteResumeAllowed(spawnMap) {
		return false, nil
	}
	config, ok := readRemoteResumeConfig(ctx, aiHome)
	if !ok || !probeRemoteResume(ctx, config.host, config.port) {
		return false, nil
	}
	cwd, injectCwd := resolveResumeScope(forward)
	remoteURL := "ws://" + config.host + ":" + strconv.Itoa(config.port)
	authToken := config.authToken
	var proxy *scopedResumeProxy
	if injectCwd && strings.TrimSpace(cwd) != "" {
		var err error
		proxy, err = startScopedResumeProxy(ctx, remoteURL, authToken, cwd, spawnEnv, runtime.stderr)
		if err != nil {
			return true, err
		}
		defer proxy.Close()
		remoteURL = proxy.RemoteURL
		authToken = proxy.Token
	} else {
		remoteURL = withAllProjectsURL(remoteURL)
	}
	stripped, removed := codexappconfig.StripPermissionOverrides(forward)
	if len(removed) > 0 {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 远程恢复会话时不接受权限覆盖，已忽略：%s\n", strings.Join(removed, " "))
	}
	launchArgs := injectRemoteResumeArgs(stripped, remoteURL, authToken)
	env := append([]string{}, spawnEnv...)
	if authToken != "" {
		env = append(env, remoteResumeTokenEnv+"="+authToken)
	}
	return true, runCodexResumeChild(ctx, upstream, launchArgs, env, runtime)
}

func remoteResumeAllowed(env map[string]string) bool {
	flags := splitCodexFlags(env["AIH_CODEX_FLAGS"])
	if flags["disableRemoteResume"] == "1" {
		return false
	}
	key := strings.TrimSpace(env["OPENAI_API_KEY"])
	ref := strings.TrimSpace(env["AIH_CODEX_GATEWAY_ACCOUNT_REF"])
	if key != "" {
		return ref == ""
	}
	return flags["managedLaunch"] == "1"
}

func readRemoteResumeConfig(ctx context.Context, aiHome string) (remoteResumeConfig, bool) {
	root := strings.TrimSpace(aiHome)
	if root == "" {
		return remoteResumeConfig{}, false
	}
	database, err := appstate.DatabasePath(root)
	if err != nil {
		return remoteResumeConfig{}, false
	}
	raw, found, err := appstate.ReadKV(ctx, database, appstate.KeyServerConfig)
	if err != nil || !found {
		return remoteResumeConfig{}, false
	}
	var config map[string]any
	if json.Unmarshal([]byte(raw), &config) != nil {
		return remoteResumeConfig{}, false
	}
	host := strings.TrimSpace(resumeStringValue(config["host"]))
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	port := int(resumeNumberValue(config["port"]))
	if port < 1 || port > 65535 {
		return remoteResumeConfig{}, false
	}
	return remoteResumeConfig{host: host, port: port, authToken: strings.TrimSpace(stringValue(config["apiKey"]))}, true
}

func probeRemoteResume(ctx context.Context, host string, port int) bool {
	dialer := net.Dialer{Timeout: 180 * time.Millisecond}
	connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

func resolveResumeScope(args []string) (string, bool) {
	directory, err := os.Getwd()
	if err != nil {
		directory = ""
	}
	allProjects := false
	valueFlags := map[string]bool{
		"-c": true, "--config": true, "-m": true, "--model": true, "-p": true, "--profile": true,
		"--enable": true, "--disable": true, "--remote": true, "--remote-auth-token-env": true,
		"-a": true, "--ask-for-approval": true, "-s": true, "--sandbox": true,
		"-i": true, "--image": true, "--add-dir": true, "--local-provider": true,
	}
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		if token == "--" {
			break
		}
		switch {
		case token == "--all":
			allProjects = true
		case token == "-C" || token == "--cd":
			if index+1 < len(args) {
				index++
				if candidate := strings.TrimSpace(args[index]); candidate != "" {
					directory = resolvePath(directory, candidate)
				}
			}
		case strings.HasPrefix(token, "--cd="):
			directory = resolvePath(directory, strings.TrimPrefix(token, "--cd="))
		case strings.HasPrefix(token, "-C") && len(token) > 2:
			directory = resolvePath(directory, token[2:])
		case valueFlags[token]:
			index++
		}
	}
	return directory, !allProjects
}

func resolvePath(base, value string) string {
	if filepath.IsAbs(value) || base == "" {
		return filepath.Clean(value)
	}
	return filepath.Join(base, value)
}

func withAllProjectsURL(remoteURL string) string {
	if strings.Contains(remoteURL, "?") {
		return remoteURL + "&aih_all_projects=1"
	}
	return remoteURL + "?aih_all_projects=1"
}

func injectRemoteResumeArgs(args []string, remoteURL, authToken string) []string {
	resumeIndex := -1
	for index, token := range args {
		if strings.TrimSpace(token) == "resume" {
			resumeIndex = index
			break
		}
	}
	injected := []string{"--remote", remoteURL}
	if authToken != "" {
		injected = append(injected, "--remote-auth-token-env", remoteResumeTokenEnv)
	}
	if resumeIndex < 0 {
		return append(injected, args...)
	}
	launch := make([]string, 0, len(args)+len(injected))
	launch = append(launch, args[:resumeIndex+1]...)
	launch = append(launch, injected...)
	launch = append(launch, args[resumeIndex+1:]...)
	return launch
}

func startScopedResumeProxy(ctx context.Context, remoteURL, authToken, cwd string, env []string, stderr interface{ Write([]byte) (int, error) }) (*scopedResumeProxy, error) {
	binary, err := resolveRemoteControlBinary()
	if err != nil {
		return nil, err
	}
	localToken, err := randomToken()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, binary, "__codex-resume-proxy", "--host", "127.0.0.1", "--parent-pid", strconv.Itoa(os.Getpid()))
	command.Env = env
	command.Stderr = stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	proxy := &scopedResumeProxy{command: command, stdin: stdin}
	config, err := json.Marshal(map[string]any{
		"remoteUrl": remoteURL, "cwd": cwd, "authToken": authToken, "localToken": localToken,
	})
	if err != nil {
		proxy.Close()
		return nil, err
	}
	if _, err := stdin.Write(append(config, '\n')); err != nil {
		proxy.Close()
		return nil, err
	}
	_ = stdin.Close()
	reader := bufio.NewReaderSize(stdout, 16<<10)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		proxy.Close()
		return nil, errors.New("resume_proxy_ready_invalid")
	}
	var ready map[string]any
	if json.Unmarshal(line, &ready) != nil || ready["ok"] != true {
		proxy.Close()
		return nil, errors.New("resume_proxy_ready_invalid")
	}
	port := int(resumeNumberValue(ready["port"]))
	if port < 1 || port > 65535 {
		proxy.Close()
		return nil, errors.New("resume_proxy_ready_invalid")
	}
	host := resumeStringValue(ready["host"])
	if host == "::1" {
		host = "[::1]"
	}
	if host == "" {
		host = "127.0.0.1"
	}
	proxy.RemoteURL = "ws://" + host + ":" + strconv.Itoa(port)
	proxy.Token = localToken
	return proxy, nil
}

func runCodexResumeChild(ctx context.Context, upstream string, args, env []string, runtime commandRuntime) error {
	command := exec.CommandContext(ctx, upstream, args...)
	command.Env = env
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	err := command.Run()
	if exitErr, ok := err.(*exec.ExitError); ok {
		os.Exit(exitErr.ExitCode())
	}
	return err
}

func resumeStringValue(value any) string {
	text, _ := value.(string)
	return text
}

func resumeNumberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case json.Number:
		number, _ := typed.Float64()
		return number
	}
	return 0
}
