package chatruntime

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"
)

const nativeLaunchReleaseTimeout = 20 * time.Second

var errNativeLaunchCaptureFailed = NewError("native_launch_capture_failed", http.StatusBadGateway, nil)

func onceNativeLaunchRelease(release func(context.Context) error) func(context.Context) error {
	if release == nil {
		return nil
	}
	var once sync.Once
	var captureErr error
	return func(ctx context.Context) error {
		once.Do(func() {
			captureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), nativeLaunchReleaseTimeout)
			defer cancel()
			if err := release(captureCtx); err != nil {
				// Provider errors may contain credentials; expose the failure, not their payload.
				captureErr = errNativeLaunchCaptureFailed
			}
		})
		return captureErr
	}
}

func releaseNativeLaunch(ctx context.Context, plan NativeLaunchPlan) error {
	if plan.Release == nil {
		return nil
	}
	return plan.Release(ctx)
}

func nativeLaunchCaptureFailed(err error) bool {
	if errors.Is(err, errNativeLaunchCaptureFailed) {
		return true
	}
	// Driver diagnostics may wrap a stable runtime code after joining process
	// and capture errors. Preserve this side-effect failure across that boundary.
	if runtimeErr, ok := AsRuntimeError(err); ok {
		return runtimeErr.Code == "native_launch_capture_failed"
	}
	return false
}

// A cancelled turn must not abandon Capture's result. Drain without projecting
// more text; bound a misbehaving host Release even if it ignores its context.
func cancelledNativeLaunchResult(handle *NativeRunHandle) ProviderRunResult {
	timer := time.NewTimer(nativeLaunchReleaseTimeout + 2*nativeStreamErrorSettleTimeout)
	defer timer.Stop()
	events, sessionIDs := handle.Events, handle.SessionIDs
	for {
		select {
		case exit, ok := <-handle.Done:
			if !ok {
				return ProviderRunResult{Err: NewError("native_launch_exit_missing", http.StatusBadGateway, nil)}
			}
			if nativeLaunchCaptureFailed(exit.Err) {
				return ProviderRunResult{Err: errNativeLaunchCaptureFailed}
			}
			return ProviderRunResult{Result: map[string]any{"status": "interrupted"}}
		case _, ok := <-events:
			if !ok {
				events = nil
			}
		case _, ok := <-sessionIDs:
			if !ok {
				sessionIDs = nil
			}
		case <-timer.C:
			return ProviderRunResult{Err: NewError("native_launch_release_timeout", http.StatusGatewayTimeout, nil)}
		}
	}
}

// Keep an original process error intact when preparation needs no release error.
func joinNativeLaunchError(processErr, releaseErr error) error {
	if releaseErr == nil {
		return processErr
	}
	return errors.Join(processErr, releaseErr)
}
