//go:build !windows

package artifactstore

import "errors"

// createJunction 只在 Windows 有意义；其它平台走 os.Symlink。
func createJunction(target, link string) error {
	return errors.New("junction_unsupported_platform")
}
