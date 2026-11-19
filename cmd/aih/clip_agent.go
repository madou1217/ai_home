package main

import "github.com/madou1217/ai_home/internal/runtime/sshbridge"

func runClipAgent(arguments []string, runtime commandRuntime) error {
	code := sshbridge.RunClipAgentCommand(arguments, runtime.stdout, runtime.stderr)
	if code != 0 {
		return cliExitCode{code: code}
	}
	return nil
}
