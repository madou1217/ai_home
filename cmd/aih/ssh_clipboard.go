package main

import (
	"os"

	"github.com/madou1217/ai_home/internal/runtime/sshterminalclip"
)

func runSSHClipboard(arguments []string, runtime commandRuntime) error {
	stdin, _ := runtime.stdin.(*os.File)
	if stdin == nil {
		stdin = os.Stdin
	}
	code := sshterminalclip.RunProbe(arguments, stdin, runtime.stdout, runtime.stderr, func(name string) string {
		value, _ := runtime.lookupEnv(name)
		return value
	})
	if code != 0 {
		return cliExitCode{code: code}
	}
	return nil
}
