package main

import (
	"github.com/madou1217/ai_home/internal/runtime/harnessrun"
)

// `aih harness` 的外部 harness 启动器；投影适配器在 harnessrun 包中实现。
func runHarness(arguments []string, runtime commandRuntime) error {
	code := harnessrun.Run(arguments, harnessrun.Runtime{
		LookupEnv:   runtime.lookupEnv,
		UserHomeDir: runtime.userHomeDir,
		Stdin:       runtime.stdin,
		Stdout:      runtime.stdout,
		Stderr:      runtime.stderr,
	})
	if code == 0 {
		return nil
	}
	return cliExitCode{code: code}
}
