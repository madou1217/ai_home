package nativeterminal

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	"github.com/madou1217/ai_home/application/providerruntime"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
)

// reconcile never deletes a canonical auth projection or migrates session files.
// RunCLI/providercli is the sole credential capture owner. In particular, never
// read a newer credential snapshot and Capture an older projection against it:
// opaque materializers can otherwise roll back a concurrently refreshed token.
// Only shared-link/resource integrity is checked here; unexpected real files
// retain the registry rather than losing user data.
func reconcile(ctx context.Context, home string, entry Entry, hostHome string) error {
	if entry.Provider != entry.IdentityProvider {
		return nil
	} // Gateway owns no account projection.
	policies := providerstorage.New()
	policy, ok := policies.Policy(entry.IdentityProvider)
	if !ok || policy.Mode == appprojection.ModeNone {
		return nil
	}
	root := providerruntime.ResolveCLIAuthProjectionDir(filepath.Join(home, "run", "auth-projections", entry.IdentityProvider, entry.AccountRef), entry.IdentityProvider)
	st, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return ErrInvalid
	}
	if hostHome == "" {
		hostHome, _ = os.UserHomeDir()
	}
	if !filepath.IsAbs(hostHome) {
		return ErrInvalid
	}
	for _, mapping := range policy.ProjectionRoots {
		for _, name := range policy.SharedEntries {
			if err := ctx.Err(); err != nil {
				return err
			}
			source := filepath.Join(append([]string{root}, append(mapping.From, name)...)...)
			target := filepath.Join(append([]string{hostHome}, append(mapping.To, name)...)...)
			info, err := os.Lstat(source)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			resolved, err := filepath.EvalSymlinks(source)
			expected, expectedErr := filepath.EvalSymlinks(target)
			if err != nil || expectedErr != nil || filepath.Clean(resolved) != filepath.Clean(expected) {
				// Empty optional shared slots may not yet have been created by the CLI.
				if info.IsDir() {
					children, readErr := os.ReadDir(source)
					if readErr == nil && len(children) == 0 {
						continue
					}
				}
				return errors.New("native_terminal_shared_resources_unreconciled")
			}
		}
	}
	return nil
}
