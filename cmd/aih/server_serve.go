package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// runServerServe handles foreground serve only for the Go server's native
// flags. Provider-specific serve options still delegate to the legacy CLI.
func runServerServe(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	var serveArgs []string
	switch {
	case len(arguments) >= 2 && arguments[0] == "server" && arguments[1] == "serve":
		serveArgs = arguments[2:]
	case len(arguments) >= 2 && arguments[0] == "serve":
		serveArgs = arguments[1:]
	default:
		return false, nil
	}
	hasWebDir := false
	for index := 0; index < len(serveArgs); index++ {
		token := serveArgs[index]
		switch {
		case token == "--host" || token == "--port":
			if index+1 >= len(serveArgs) {
				return true, fmt.Errorf("%s requires a value", token)
			}
			index++
		case strings.HasPrefix(token, "--host=") || strings.HasPrefix(token, "--port="):
		case token == "--web-dir":
			hasWebDir = true
			if index+1 >= len(serveArgs) {
				return true, errors.New("--web-dir requires a value")
			}
			index++
		case strings.HasPrefix(token, "--web-dir="):
			hasWebDir = true
		case token == "--help" || token == "-h":
			showServerUsage(runtime)
			return true, nil
		default:
			// 所有 serve 选项都交给 Go 服务器自己的 flag 解析器；未知选项由它报错。
			continue
		}
	}
	options, err := resolveAutostartOptions(runtime)
	if err != nil {
		return true, err
	}
	if !hasWebDir && options.WebDir != "" {
		serveArgs = append(serveArgs, "--web-dir", options.WebDir)
	}
	command := exec.CommandContext(ctx, options.ServerBinary, serveArgs...)
	command.Env = os.Environ()
	command.Env = append(command.Env, "AIH_HOME_DIR="+options.Home)
	command.Stdin = runtime.stdin
	command.Stdout = runtime.stdout
	command.Stderr = runtime.stderr
	return true, command.Run()
}
