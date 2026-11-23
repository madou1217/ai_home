package tuningress

import (
	"fmt"
	"os"
	"path/filepath"
)

const runtimeConfigFileName = "config.json"

// writeCheckConfig creates a unique 0600 file for a dry-run check. The caller
// owns removal of the returned path.
func writeCheckConfig(data []byte) (string, error) {
	file, err := os.CreateTemp("", "aih-tuningress-check-*.json")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrConfigFile, err)
	}
	path := file.Name()
	if err := writeSecureConfig(file, data); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("%w: %v", ErrConfigFile, err)
	}
	return path, nil
}

// writeRuntimeConfig creates a private directory and a 0600 config file that
// stays on disk only while the created sing-box process is supervised. The
// caller owns removal of the returned directory.
func writeRuntimeConfig(data []byte) (string, string, error) {
	dir, err := os.MkdirTemp("", "aih-tuningress-*")
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrConfigFile, err)
	}
	path := filepath.Join(dir, runtimeConfigFileName)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("%w: %v", ErrConfigFile, err)
	}
	if err := writeSecureConfig(file, data); err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("%w: %v", ErrConfigFile, err)
	}
	return dir, path, nil
}

func writeSecureConfig(file *os.File, data []byte) error {
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
