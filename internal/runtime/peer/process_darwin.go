//go:build darwin

package peer

import (
	"bytes"
	"encoding/binary"
	"errors"

	"golang.org/x/sys/unix"
)

// KERN_PROCARGS2 keeps argv boundaries and the ancestor's own environment.
// Secrets are never returned to CLI output, diagnostics, or persistent records.
func processLaunch(pid int) ([]string, map[string]string, error) {
	raw, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return nil, nil, err
	}
	if len(raw) < 5 {
		return nil, nil, errors.New("peer_process_args_unavailable")
	}
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	if argc < 1 || argc > 65536 {
		return nil, nil, errors.New("peer_process_args_invalid")
	}
	raw = raw[4:]
	end := bytes.IndexByte(raw, 0)
	if end < 0 {
		return nil, nil, errors.New("peer_process_path_invalid")
	}
	raw = bytes.TrimLeft(raw[end+1:], "\x00")
	args := make([]string, 0, argc)
	for len(args) < argc {
		end = bytes.IndexByte(raw, 0)
		if end < 0 {
			return nil, nil, errors.New("peer_process_argv_incomplete")
		}
		args = append(args, string(raw[:end]))
		raw = raw[end+1:]
	}
	env := map[string]string{}
	for _, item := range bytes.Split(raw, []byte{0}) {
		at := bytes.IndexByte(item, '=')
		if at > 0 {
			key := string(item[:at])
			switch key {
			case "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_HOME", "HOME", "TMUX", "TMUX_PANE":
				env[key] = string(item[at+1:])
			}
		}
	}
	return args, env, nil
}
