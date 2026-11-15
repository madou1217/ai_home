//go:build !darwin && !linux && !windows

package fileexchange

import "fmt"

func Exchange(source, target string) (string, error) {
	return "", fmt.Errorf("codex_host_safe_replace_unsupported")
}
func MoveAside(source, target string) error {
	return fmt.Errorf("codex_host_safe_replace_unsupported")
}
