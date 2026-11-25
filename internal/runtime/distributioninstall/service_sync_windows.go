//go:build windows

package distributioninstall

import (
	"os"
	"path/filepath"
	"strings"
)

// syncLegacyServiceFiles keeps the pre-autostart Windows service layout in
// sync with the versioned package. Older installs launch
// <home>\bin\aih-server.exe via <home>\bin\run.cmd, while the installer
// publishes the new runtime under <home>\pkg\<release>. Without this sync an
// upgrade leaves the task pointing at the previous server binary.
func syncLegacyServiceFiles(o Options) error {
	runScript := filepath.Join(o.Home, "bin", "run.cmd")
	info, err := os.Lstat(runScript)
	if err != nil || info.IsDir() {
		return nil
	}
	nativeDir := filepath.Join(o.PackageRoot, "bin", "native", Target())
	entries, err := os.ReadDir(nativeDir)
	if err != nil {
		return err
	}
	binDir := filepath.Join(o.Home, "bin")
	if err := os.MkdirAll(binDir, 0700); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".build.json") {
			continue
		}
		if err := copyFile(filepath.Join(nativeDir, entry.Name()), filepath.Join(binDir, entry.Name()), 0755); err != nil {
			return err
		}
	}
	webSource := filepath.Join(o.PackageRoot, "web", "dist")
	if info, err := os.Stat(filepath.Join(webSource, "index.html")); err != nil || info.IsDir() {
		return nil
	}
	return replaceDirectory(webSource, filepath.Join(o.Home, "web", "dist"))
}

func replaceDirectory(source, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	temporary := target + ".new-" + randomID()
	if err := copyDirectory(source, temporary); err != nil {
		_ = os.RemoveAll(temporary)
		return err
	}
	previous := target + ".old-" + randomID()
	if _, err := os.Lstat(target); err == nil {
		if err := os.Rename(target, previous); err != nil {
			_ = os.RemoveAll(temporary)
			return err
		}
	} else if !os.IsNotExist(err) {
		_ = os.RemoveAll(temporary)
		return err
	}
	if err := os.Rename(temporary, target); err != nil {
		_ = os.RemoveAll(temporary)
		if _, statErr := os.Lstat(previous); statErr == nil {
			_ = os.Rename(previous, target)
		}
		return err
	}
	_ = os.RemoveAll(previous)
	return nil
}

func copyDirectory(source, target string) error {
	if err := os.MkdirAll(target, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		src := filepath.Join(source, entry.Name())
		dst := filepath.Join(target, entry.Name())
		if entry.IsDir() {
			if err := copyDirectory(src, dst); err != nil {
				return err
			}
			continue
		}
		if err := copyFile(src, dst, 0644); err != nil {
			return err
		}
	}
	return nil
}
