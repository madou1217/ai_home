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

// runHarnessShorthand 承接 `aih <harness> …` 简写（外部 harness 不是 Provider）。
// 参数形态与 Node 旧入口一致，解析与启动都在 harnessrun 内完成。
func runHarnessShorthand(_ string, arguments []string, runtime commandRuntime) error {
	code := harnessrun.RunShorthand(arguments, harnessrun.Runtime{
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
