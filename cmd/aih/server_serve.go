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
	if len(arguments) < 2 || arguments[0] != "server" || arguments[1] != "serve" {
		return false, nil
	}
	serveArgs := arguments[2:]
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
			return false, nil
		default:
			// Advanced serve flags are not part of the Go server surface yet.
			return false, nil
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
