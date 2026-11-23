package tuningress

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Check renders options, writes the configuration to a temporary 0600 file,
// and runs `<sing-box> check -c <file>`. It never starts a TUN interface and
// does not require administrator/root privileges.
//
// The binary comes from Options.SingBoxPath when set; otherwise the standard
// discovery order is used. A missing binary returns ErrBinaryNotFound. A
// rejected configuration returns *CheckError (wrapping ErrCheckFailed) with
// bounded, credential-redacted output.
func Check(ctx context.Context, options Options) error {
	normalized, err := options.settings()
	if err != nil {
		return err
	}
	config, err := render(normalized)
	if err != nil {
		return err
	}
	binary, err := resolveCheckBinary(normalized.binaryPath)
	if err != nil {
		return err
	}
	configPath, err := writeCheckConfig(config)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(configPath) }()

	return runCheck(ctx, binary, configPath, normalized)
}

func runCheck(ctx context.Context, binary, configPath string, config *settings) error {
	ctx, cancel := contextWithDefaultTimeout(ctx, DefaultCheckTimeout)
	defer cancel()

	command := exec.CommandContext(ctx, binary, "check", "-c", configPath)
	output := &boundedBuffer{limit: maxCheckOutputBytes}
	command.Stdout = output
	command.Stderr = output

	if err := command.Run(); err != nil {
		if contextErr := ctx.Err(); contextErr != nil {
			return fmt.Errorf("%w: %w", ErrCheckFailed, contextErr)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			sanitized := truncateText(redactSecrets(output.String(), config), maxReportedOutputBytes)
			return &CheckError{ExitCode: exitErr.ExitCode(), Output: sanitized}
		}
		return fmt.Errorf("%w: %v", ErrCheckFailed, err)
	}
	return nil
}

func contextWithDefaultTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Deadline(); ok {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, timeout)
}
