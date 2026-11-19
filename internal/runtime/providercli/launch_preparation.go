package providercli

import "context"

// Preparation is composed by the host, never inferred by the OS process runner.
func (runner *Runner) runPreparedProviderProcess(ctx context.Context, providerID, path string, args, env []string) error {
	if runner.prepareNative != nil {
		prepared, release, err := runner.prepareNative(ctx, providerID, path, args, env)
		if err != nil {
			return err
		}
		if release != nil {
			defer release()
		}
		args = prepared
	}
	return runner.runProviderProcess(ctx, providerID, path, args, env)
}
