package providercli

import "errors"

// captureFailure carries capture ownership facts through host error wrapping.
// It deliberately does not include credential/artifact details in Error().
type captureFailure struct {
	runErr     error
	captureErr error
}

func (failure *captureFailure) Error() string { return "provider credential capture failed" }
func (failure *captureFailure) Unwrap() []error {
	if failure.runErr == nil {
		return []error{failure.captureErr}
	}
	return []error{failure.runErr, failure.captureErr}
}
func (*captureFailure) CaptureFailed() bool { return true }

// captureExitFailure keeps an existing silent process exit intact while making
// capture failure observable to a lifecycle supervisor. Non-silent runtime
// errors remain non-silent; no new exit code is invented for them.
type captureExitFailure struct {
	*captureFailure
	code int
}

func (failure *captureExitFailure) ExitCode() int { return failure.code }
func (*captureExitFailure) SilentExit()           {}

func withCaptureFailure(runErr, captureErr error) error {
	if captureErr == nil {
		return runErr
	}
	failure := &captureFailure{runErr: runErr, captureErr: captureErr}
	var silent interface {
		ExitCode() int
		SilentExit()
	}
	if runErr != nil && errors.As(runErr, &silent) {
		return &captureExitFailure{captureFailure: failure, code: silent.ExitCode()}
	}
	return failure
}
