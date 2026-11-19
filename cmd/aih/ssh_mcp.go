package main

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/sshmcp"
)

func runSSHMCPServer(arguments []string, runtime commandRuntime) error {
	target := ""
	remoteRoot := ""
	for index := 0; index < len(arguments); index++ {
		switch arguments[index] {
		case "--target":
			if index+1 < len(arguments) {
				target = strings.TrimSpace(arguments[index+1])
				index++
			}
		case "--remote-root":
			if index+1 < len(arguments) {
				remoteRoot = strings.TrimSpace(arguments[index+1])
				index++
			}
		}
	}
	if target == "" || remoteRoot == "" {
		_, _ = fmt.Fprintln(runtime.stderr, "[AIH-SSH-MCP] Error: missing sshTarget or remoteRoot")
		return cliExitCode{code: 1}
	}
	if err := sshmcp.Run(target, remoteRoot, runtime.stdin, runtime.stdout, runtime.stderr); err != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[AIH-SSH-MCP] Error: %v\n", err)
		return cliExitCode{code: 1}
	}
	return nil
}
