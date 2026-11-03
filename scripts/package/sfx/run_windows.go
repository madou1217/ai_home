//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func launch(dest string) error {
	node := filepath.Join(dest, "runtime", "node.exe")
	entry := filepath.Join(dest, "bin", "ai-home.js")
	command := exec.Command(node, append([]string{entry}, os.Args[1:]...)...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = packageEnv(dest)
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		return err
	}
	return nil
}
