package main

import (
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/runtime/backgroundsupervisor"
)

func runBackgroundSupervisorCommand(arguments []string, runtime commandRuntime) error {
	if len(arguments) != 1 || arguments[0] != "run" {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] invalid background supervisor invocation.")
		return cliExitCode{code: 1}
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	executable, execErr := os.Executable()
	if execErr != nil {
		return execErr
	}
	code := backgroundsupervisor.Run(aiHomeDir, executable, runtime.stdout, runtime.stderr)
	if code != 0 {
		return cliExitCode{code: code}
	}
	return nil
}
