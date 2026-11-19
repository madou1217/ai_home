//go:build linux

package peer

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func processLaunch(pid int) ([]string, map[string]string, error) {
	root := filepath.Join("/proc", strconv.Itoa(pid))
	raw, err := os.ReadFile(filepath.Join(root, "cmdline"))
	if err != nil {
		return nil, nil, err
	}
	args := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	raw, err = os.ReadFile(filepath.Join(root, "environ"))
	if err != nil {
		return nil, nil, err
	}
	env := map[string]string{}
	for _, item := range bytes.Split(raw, []byte{0}) {
		parts := bytes.SplitN(item, []byte{'='}, 2)
		if len(parts) == 2 {
			switch string(parts[0]) {
			case "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_HOME", "HOME", "TMUX", "TMUX_PANE":
				env[string(parts[0])] = string(parts[1])
			}
		}
	}
	return args, env, nil
}
