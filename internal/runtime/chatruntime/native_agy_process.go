package chatruntime

import (
	"context"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

func validateAGYNativeTransport(req NativeRunRequest) error {
	mode := strings.ToLower(strings.TrimSpace(req.ApprovalMode))
	if mode != "" && mode != "bypass" {
		return NewError("agy_native_approval_unsupported", http.StatusUnprocessableEntity, nil)
	}
	transport := sessionchat.ResolveNativeChatTransport(req.Provider, strings.TrimSpace(req.NativeSessionID) != "")
	if req.Slash || transport.Mode != sessionchat.ModeHeadlessStream || transport.PromptDelivery != sessionchat.PromptDeliveryArgv {
		return NewError("agy_native_transport_unsupported", http.StatusUnprocessableEntity, map[string]any{
			"transport": transport.Mode, "interactive": req.Slash,
		})
	}
	return nil
}

// Check the executable we will actually launch, not a historical version table.
// Older builds must fail visibly, never fall back to unparsed text or a TUI.
func verifyAGYStreamProtocol(ctx context.Context, binPath, workDir string, environment []string) error {
	probeCtx, cancel := context.WithTimeout(ctx, nativeStreamErrorSettleTimeout)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, binPath, "--help")
	cmd.Dir, cmd.Env = workDir, environment
	cmd.WaitDelay = nativeStreamErrorSettleTimeout
	output := &agyHelpOutput{}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return NewError("agy_cli_protocol_probe_failed", http.StatusServiceUnavailable, nil)
	}
	if output.truncated {
		return NewError("agy_cli_help_output_limit", http.StatusServiceUnavailable, nil)
	}
	for _, line := range strings.Split(output.text.String(), "\n") {
		if strings.Contains(line, "--output-format") && strings.Contains(line, "stream-json") {
			return nil
		}
	}
	return NewError("agy_cli_stream_json_unsupported", http.StatusUnprocessableEntity, nil)
}

func isAGYAuthenticationFailure(message string) bool {
	message = strings.ToLower(message)
	return strings.Contains(message, "authentication required") ||
		strings.Contains(message, "authentication failed or timed out")
}

func agyAuthenticationRequired() *Error {
	return NewErrorWithMessage("agy_authentication_required", http.StatusUnauthorized,
		"Authentication required for the selected AGY account; authorize it before starting WORK native.", nil)
}

// AGY 1.5.6 can wait for OAuth even with stdin=/dev/null and --print-timeout.
// Watch stderr as it arrives, stop the child, and never return its login URL.
func readAGYNativeStderr(reader io.Reader, abort func()) (string, error) {
	observer := &agyAuthenticationReader{Reader: reader, abort: abort}
	text := readNativeStderr(observer)
	if observer.required {
		err := agyAuthenticationRequired()
		return err.Message, err
	}
	if strings.TrimSpace(text) != "" {
		return "AGY CLI emitted diagnostics; raw provider output is withheld", nil
	}
	return "", nil
}

type agyAuthenticationReader struct {
	io.Reader
	abort    func()
	tail     string
	required bool
}

func (reader *agyAuthenticationReader) Read(buffer []byte) (int, error) {
	n, err := reader.Reader.Read(buffer)
	const marker = "authentication required"
	if n > 0 && !reader.required {
		text := strings.ToLower(reader.tail + string(buffer[:n]))
		if strings.Contains(text, marker) {
			reader.required = true
			reader.abort()
		} else {
			reader.tail = text[max(0, len(text)-len(marker)+1):]
		}
	}
	return n, err
}

// Keep draining both help streams while bounding retained output, as the normal
// native stderr reader does. An excessive help response fails closed.
type agyHelpOutput struct {
	mu        sync.Mutex
	text      strings.Builder
	truncated bool
}

func (output *agyHelpOutput) Write(data []byte) (int, error) {
	output.mu.Lock()
	defer output.mu.Unlock()
	const limit = 64 * 1024
	keep := min(len(data), limit-output.text.Len())
	output.text.Write(data[:keep])
	output.truncated = output.truncated || keep < len(data)
	return len(data), nil
}
