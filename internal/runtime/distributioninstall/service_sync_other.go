//go:build !windows

package distributioninstall

// syncLegacyServiceFiles is only needed for the Windows run.cmd service layout.
func syncLegacyServiceFiles(Options) error { return nil }
