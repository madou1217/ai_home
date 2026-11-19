package main

import (
	"io"
	"os"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

// 终端集成的内部入口在 completion 包中实现；此文件只保留进程边界。
// run.go 在解析根命令之前分发 __complete / __suggest / __learn，避免完整
// 组合根的启动开销。

func runCompleteEntry(arguments []string, runtime commandRuntime) error {
	return runCompletionEntry("__complete", arguments, runtime)
}

func runSuggestEntry(arguments []string, runtime commandRuntime) error {
	return runCompletionEntry("__suggest", arguments, runtime)
}

func runLearnEntry(arguments []string, runtime commandRuntime) error {
	return runCompletionEntry("__learn", arguments, runtime)
}

func runCompletionEntry(verb string, arguments []string, runtime commandRuntime) error {
	environment := completion.Environment{
		Getenv: func(name string) string {
			value, _ := runtime.lookupEnv(name)
			return value
		},
		UserHomeDir: runtime.userHomeDir,
		Stdin:       runtime.stdin,
		StdinIsTTY:  stdinIsTerminal(runtime.stdin),
		Stdout:      runtime.stdout,
		Stderr:      runtime.stderr,
	}
	switch verb {
	case "__complete":
		completion.RunComplete(arguments, environment)
	case "__suggest":
		completion.RunSuggest(arguments, environment)
	case "__learn":
		completion.RunLearn(arguments, environment)
	}
	return nil
}

func stdinIsTerminal(reader io.Reader) bool {
	file, ok := reader.(*os.File)
	if !ok {
		return false
	}
	return term.IsTerminal(int(file.Fd()))
}
