package mcpselection

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

const proxyMaxMessage = 8 * 1024 * 1024

// RunPrefixedProxy serves an upstream MCP server on stdio while exposing every
// tool as <id>.<tool>. AIH registers external MCPs through this proxy so their
// names never collide with native or built-in tools, and the mapping stays
// static (no "prefix only on conflict" surprises).
func RunPrefixedProxy(id string, argv []string, stdin io.Reader, stdout, stderr io.Writer) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("__mcp-prefixed: missing MCP id")
	}
	if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		return errors.New("__mcp-prefixed: missing upstream command")
	}
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = os.Environ()
	command.Stderr = stderr
	childIn, err := command.StdinPipe()
	if err != nil {
		return err
	}
	childOut, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("启动 MCP %s 失败: %w", id, err)
	}
	defer func() {
		_ = childIn.Close()
		_ = command.Wait()
	}()

	reader := bufio.NewReaderSize(childOut, proxyMaxMessage)
	writer := bufio.NewWriter(stdout)
	defer func() { _ = writer.Flush() }()
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), proxyMaxMessage)

	prefix := id + "."
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var message map[string]any
		if json.Unmarshal(line, &message) != nil {
			continue
		}
		method, _ := message["method"].(string)
		payload := line
		if method == "tools/call" && stripToolPrefix(message, prefix) {
			encoded, err := json.Marshal(message)
			if err != nil {
				return err
			}
			payload = encoded
		}
		idValue, hasID := message["id"]
		if _, err := childIn.Write(append(payload, '\n')); err != nil {
			return err
		}
		if !hasID {
			continue
		}
		// Requests are answered in order; notifications emitted meanwhile are
		// forwarded unchanged so the provider still sees server pushes.
		for {
			replyLine, err := reader.ReadBytes('\n')
			if err != nil {
				return err
			}
			trimmed := bytes.TrimSpace(replyLine)
			if len(trimmed) == 0 {
				continue
			}
			var reply map[string]any
			if json.Unmarshal(trimmed, &reply) != nil {
				if _, err := writer.Write(append(trimmed, '\n')); err != nil {
					return err
				}
				continue
			}
			if replyID, ok := reply["id"]; ok && fmt.Sprint(replyID) == fmt.Sprint(idValue) {
				if method == "tools/list" {
					applyToolPrefix(reply, prefix)
				}
				encoded, err := json.Marshal(reply)
				if err != nil {
					return err
				}
				if _, err := writer.Write(append(encoded, '\n')); err != nil {
					return err
				}
				break
			}
			if _, err := writer.Write(append(trimmed, '\n')); err != nil {
				return err
			}
		}
		if err := writer.Flush(); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// stripToolPrefix rewrites an outbound tools/call to the upstream name.
func stripToolPrefix(message map[string]any, prefix string) bool {
	params, _ := message["params"].(map[string]any)
	if params == nil {
		return false
	}
	name, _ := params["name"].(string)
	if !strings.HasPrefix(name, prefix) {
		return false
	}
	params["name"] = strings.TrimPrefix(name, prefix)
	return true
}

// applyToolPrefix rewrites a tools/list response to the AIH-visible names.
func applyToolPrefix(reply map[string]any, prefix string) {
	result, _ := reply["result"].(map[string]any)
	if result == nil {
		return
	}
	tools, _ := result["tools"].([]any)
	for _, entry := range tools {
		tool, _ := entry.(map[string]any)
		name, _ := tool["name"].(string)
		if name == "" || strings.HasPrefix(name, prefix) {
			continue
		}
		tool["name"] = prefix + name
	}
}

// PrefixedArgv describes the provider command for a registry MCP mounted
// through the prefix proxy. Element 0 is the current aih executable, so callers
// map it to the provider's "command" and the remainder to "args".
func PrefixedArgv(self, id string, definitionCommand []string) []string {
	argv := []string{self, "__mcp-prefixed", id, "--"}
	argv = append(argv, definitionCommand...)
	return argv
}
