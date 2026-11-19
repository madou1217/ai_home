package main

import (
	"os"

	"github.com/madou1217/ai_home/internal/runtime/sshbridge"
)

func runSSH(arguments []string, runtime commandRuntime) error {
	stdin, _ := runtime.stdin.(*os.File)
	if stdin == nil {
		stdin = os.Stdin
	}
	code := sshbridge.Run(arguments, stdin, runtime.stdout, runtime.stderr)
	if code != 0 {
		return cliExitCode{code: code}
	}
	return nil
}
