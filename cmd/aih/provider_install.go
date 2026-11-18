package main

import "context"

func runProviderInstall(ctx context.Context, provider string, arguments []string, runtime commandRuntime) error {
	return runProviderLifecycle(ctx, provider, "install", arguments, runtime)
}
