// Package multiplexer defines the Go SPI for persistent provider sessions.
// It mirrors the Node contract while keeping process execution injectable.
package multiplexer

import (
	"errors"
	"strings"
)

var ErrInvalidSession = errors.New("persistent session name invalid")

type Command struct {
	Path string
	Args []string
}

type LaunchOptions struct {
	Command  string
	Socket   string
	Session  string
	CWD      string
	Inner    Command
	Detached bool
}

type Invocation struct {
	Command  string
	Args     []string
	Socket   string
	Session  string
	Detached bool
}

type AttachOptions struct {
	Command string
	Socket  string
	Session string
	Share   bool
}

type ListOptions struct {
	Command string
	Socket  string
}

type KillOptions struct {
	Command string
	Socket  string
	Session string
}

type TmuxDriver struct{}

func NewTmuxDriver() *TmuxDriver { return &TmuxDriver{} }

func (driver *TmuxDriver) BuildLaunch(options LaunchOptions) Invocation {
	args := baseArgs(options.Socket)
	if options.Detached {
		args = append(args, "new-session", "-A", "-d")
	} else {
		args = append(args, "new-session")
	}
	args = append(args, "-s", options.Session)
	if options.CWD != "" {
		args = append(args, "-c", options.CWD)
	}
	args = append(args, "--", options.Inner.Path)
	args = append(args, options.Inner.Args...)
	return Invocation{Command: commandOrDefault(options.Command), Args: args, Socket: options.Socket, Session: options.Session, Detached: options.Detached}
}

func (driver *TmuxDriver) BuildAttach(options LaunchOptions, share bool) Invocation {
	args := baseArgs(options.Socket)
	args = append(args, "attach-session")
	if !share {
		args = append(args, "-d")
	}
	args = append(args, "-t", options.Session)
	return Invocation{Command: commandOrDefault(options.Command), Args: args, Socket: options.Socket, Session: options.Session}
}

func (driver *TmuxDriver) List(options ListOptions) Invocation {
	return Invocation{
		Command: commandOrDefault(options.Command),
		Args:    append(baseArgs(options.Socket), "list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_created}\t#{session_path}"),
		Socket:  options.Socket,
	}
}

func (driver *TmuxDriver) Kill(options KillOptions) (Invocation, error) {
	if !safeSessionName(options.Session) {
		return Invocation{}, ErrInvalidSession
	}
	return Invocation{Command: commandOrDefault(options.Command), Args: append(baseArgs(options.Socket), "kill-session", "-t", options.Session), Socket: options.Socket, Session: options.Session}, nil
}

func baseArgs(socket string) []string { return []string{"-u", "-L", socket} }
func commandOrDefault(command string) string {
	if strings.TrimSpace(command) == "" {
		return "tmux"
	}
	return command
}
func safeSessionName(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 256 || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character <= ' ' || strings.ContainsRune("\x00\t\r\n'\";|&$`", character) {
			return false
		}
	}
	return true
}
