package main

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	capabilitybaseline "github.com/madou1217/ai_home/contracts/model-capabilities"
	capabilitycontract "github.com/madou1217/ai_home/internal/adapters/modelcapabilities/contract"
	"github.com/madou1217/ai_home/internal/runtime/harnessrun"
)

// harnessCapabilities 提供 CLI 侧的能力基线来源；加载失败时退化为只用网关目录。
func harnessCapabilities() modelmetadata.FactsSource {
	source, err := capabilitycontract.New(capabilitybaseline.Embedded())
	if err != nil {
		return nil
	}
	return source
}

// `aih harness` 的外部 harness 启动器；投影适配器在 harnessrun 包中实现。
func runHarness(arguments []string, runtime commandRuntime) error {
	if len(arguments) > 0 && !strings.HasPrefix(arguments[0], "-") {
		if handled, err := maybeRunInTmux(context.Background(), runtime, arguments[0], append([]string{"harness"}, arguments...)); handled {
			return err
		}
	}
	code := harnessrun.Run(arguments, harnessrun.Runtime{
		LookupEnv:    runtime.lookupEnv,
		UserHomeDir:  runtime.userHomeDir,
		Stdin:        runtime.stdin,
		Stdout:       runtime.stdout,
		Stderr:       runtime.stderr,
		Capabilities: harnessCapabilities(),
	})
	if code == 0 {
		return nil
	}
	return cliExitCode{code: code}
}

// runHarnessShorthand 承接 `aih <harness> …` 简写（外部 harness 不是 Provider）。
// 参数形态与 Node 旧入口一致，解析与启动都在 harnessrun 内完成。
func runHarnessShorthand(harnessID string, arguments []string, runtime commandRuntime) error {
	if handled, err := maybeRunInTmux(context.Background(), runtime, harnessID, arguments); handled {
		return err
	}
	code := harnessrun.RunShorthand(arguments, harnessrun.Runtime{
		LookupEnv:    runtime.lookupEnv,
		UserHomeDir:  runtime.userHomeDir,
		Stdin:        runtime.stdin,
		Stdout:       runtime.stdout,
		Stderr:       runtime.stderr,
		Capabilities: harnessCapabilities(),
	})
	if code == 0 {
		return nil
	}
	return cliExitCode{code: code}
}
