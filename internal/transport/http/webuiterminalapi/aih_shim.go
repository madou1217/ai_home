package webuiterminalapi

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// prepareAihShim routes the session/list commands that Go already owns to the
// sibling Go CLI. An unavailable Node runtime must not disable those commands;
// the remaining public commands still use the existing Node entry.
func prepareAihShim() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	root := repositoryRootFromExecutable()
	if root == "" {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	// Native package contract: aih-go is adjacent to the running aih-server. Do
	// not execute this server as a CLI and do not recurse through PATH/aih.
	cli := filepath.Join(filepath.Dir(executable), "aih-go")
	node, _ := exec.LookPath("node")
	body := aihShimBody(cli, node, filepath.Join(root, "bin", "ai-home.js"))
	directory := filepath.Join(root, ".runtime-bin")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return ""
	}
	file := filepath.Join(directory, "aih")
	existing, _ := os.ReadFile(file)
	if string(existing) != body {
		if err := os.WriteFile(file, []byte(body), 0o755); err != nil {
			return ""
		}
	}
	if err := os.Chmod(file, 0o755); err != nil {
		return ""
	}
	return directory
}

func aihShimBody(cli string, node string, entry string) string {
	body := "#!/bin/sh\n" +
		`if [ "$#" -ge 1 ]; then` + "\n" +
		`  case "$1" in` + "\n" +
		`    ss|sessions|ls) exec ` + quoteAihShimArgument(cli) + ` "$@" ;;` + "\n" +
		`  esac` + "\n" +
		`fi` + "\n"
	if node == "" {
		return body + "printf '%s\\n' '[aih] Node CLI runtime unavailable for this command.' >&2\nexit 127\n"
	}
	return body + "exec " + quoteAihShimArgument(node) + " " + quoteAihShimArgument(entry) + ` "$@"` + "\n"
}

func quoteAihShimArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
