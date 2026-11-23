package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

// runPrefixedMCPEntry is the hidden entry used as the child command for
// registry MCPs: `aih __mcp-prefixed <id> -- <command> [args...]`.
func runPrefixedMCPEntry(args []string) int {
	if len(args) < 3 || args[1] != "--" {
		_, _ = fmt.Fprintln(os.Stderr, "aih: 用法: aih __mcp-prefixed <id> -- <command> [args...]")
		return 2
	}
	id := args[0]
	command := args[2:]
	if err := mcpselection.RunPrefixedProxy(id, command, os.Stdin, os.Stdout, os.Stderr); err != nil {
		if !errors.Is(err, os.ErrClosed) {
			_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		}
		return 1
	}
	return 0
}
