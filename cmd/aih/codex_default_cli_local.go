package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const localRemoteTokenEnv = "AIH_CODEX_LOCAL_REMOTE_TOKEN"

type localAppServer struct {
	RemoteURL string
	Token     string
	command   *exec.Cmd
	stdin     io.WriteCloser
	cleanup   func()
}

// startLocalAppServer 启动 aih-server __codex-local-app-server，读取 ready 端口。
func startLocalAppServer(ctx context.Context, upstream string, cliArgs []string, env []string, stderr io.Writer) (*localAppServer, error) {
	binary, err := resolveRemoteControlBinary()
	if err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, binary, "__codex-local-app-server", "--parent-pid", strconv.Itoa(os.Getpid()))
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
	proxy := &localAppServer{command: command, stdin: stdin}
	fail := func(cause error) (*localAppServer, error) {
		proxy.Close()
		return nil, cause
	}
	token, err := randomToken()
	if err != nil {
		return fail(err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fail(err)
	}
	config := map[string]any{
		"command": upstream,
		"args":    append([]string{"app-server"}, append(extractLocalConfigArgs(cliArgs), "--listen", "stdio://")...),
		"cwd":     cwd, "authToken": token, "injectCwd": true,
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return fail(err)
	}
	if _, err := stdin.Write(append(encoded, '\n')); err != nil {
		return fail(err)
	}
	_ = stdin.Close()
	ready := make(chan map[string]any, 1)
	readErr := make(chan error, 1)
	go func() {
		reader := bufio.NewReaderSize(stdout, 16<<10)
		line, err := reader.ReadBytes('\n')
		if err != nil {
			readErr <- err
			return
		}
		var parsed map[string]any
		if json.Unmarshal(line, &parsed) != nil {
			readErr <- errors.New("codex_local_ready_invalid")
			return
		}
		ready <- parsed
	}()
	select {
	case <-ctx.Done():
		return fail(ctx.Err())
	case err := <-readErr:
		return fail(fmt.Errorf("codex_local_ready_invalid: %w", err))
	case parsed := <-ready:
		port := 0
		if number, ok := parsed["port"].(float64); ok {
			port = int(number)
		}
		if parsed["ok"] != true || port < 1 || port > 65535 {
			return fail(errors.New("codex_local_ready_invalid"))
		}
		proxy.RemoteURL = fmt.Sprintf("ws://127.0.0.1:%d", port)
		proxy.Token = token
		// 登记 token，让 TUI 断线提示里的重连命令在新 shell 中可用。
		if cleanup, cleanupErr := publishLocalAppServerToken(env, proxy.RemoteURL, token); cleanupErr != nil {
			_, _ = fmt.Fprintf(stderr, "[aih] 未能登记本地 app-server token：%v\n", cleanupErr)
		} else {
			proxy.cleanup = cleanup
		}
		return proxy, nil
	case <-time.After(5 * time.Second):
		return fail(errors.New("codex_local_ready_timeout"))
	}
}

func (proxy *localAppServer) Close() {
	if proxy == nil {
		return
	}
	if proxy.cleanup != nil {
		proxy.cleanup()
	}
	if proxy.stdin != nil {
		_ = proxy.stdin.Close()
	}
	if proxy.command != nil && proxy.command.Process != nil {
		_ = proxy.command.Process.Kill()
		_, _ = proxy.command.Process.Wait()
	}
}

// extractLocalConfigArgs 把 TUI 参数里 codex app-server 能接受的配置项提取出来。
func extractLocalConfigArgs(args []string) []string {
	result := make([]string, 0)
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		if token == "--" {
			break
		}
		flag := token
		value := ""
		inline := false
		if strings.HasPrefix(token, "--") {
			if cut := strings.Index(token, "="); cut > 0 {
				flag, value, inline = token[:cut], token[cut+1:], true
			}
		}
		switch flag {
		case "-c", "--config", "--enable", "--disable":
			if !inline {
				if index+1 >= len(args) {
					continue
				}
				value = args[index+1]
				index++
			}
			result = append(result, flag, value)
		case "-m", "--model":
			if !inline {
				if index+1 >= len(args) {
					continue
				}
				value = args[index+1]
				index++
			}
			result = append(result, "-c", "model="+strconv.Quote(value))
		}
	}
	return result
}

func localAppServerDisabled(env map[string]string, args []string) bool {
	for _, token := range args {
		if token == "--" {
			break
		}
		if token == "-p" || token == "--profile" || strings.HasPrefix(token, "--profile=") {
			return true
		}
	}
	flags := splitCodexFlags(env["AIH_CODEX_FLAGS"])
	return flags["tuiLocalRemote"] == "0"
}

func splitCodexFlags(raw string) map[string]string {
	values := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		name, value, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		values[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	return values
}

func randomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
