// Command aih-launch is the stable parent process for the managed service on
// macOS. TCC attributes Screen Recording and Accessibility to the "responsible
// process" of a child, so granting permissions to the frequently rebuilt server
// breaks on every upgrade. This launcher rarely changes: it spawns the server,
// waits for it, forwards termination signals, and mirrors its exit code.
//
// It must stay byte-identical across releases. Any change to this source (or to
// the Go toolchain) produces a new code identity and requires the user to grant
// the system permissions again.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

func main() {
	target, args, err := split(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "aih-launch: %v\n", err)
		os.Exit(2)
	}
	command := exec.Command(target, args...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "aih-launch: start %s: %v\n", target, err)
		os.Exit(1)
	}
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for received := range signals {
			_ = command.Process.Signal(received)
		}
	}()
	if err := command.Wait(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "aih-launch: wait: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// split accepts "aih-launch -- <server> [args...]" and the bare form.
func split(argv []string) (string, []string, error) {
	if len(argv) == 0 {
		return "", nil, errors.New("missing target command")
	}
	if argv[0] == "--" {
		argv = argv[1:]
		if len(argv) == 0 {
			return "", nil, errors.New("missing target command")
		}
	}
	return argv[0], argv[1:], nil
}
