package distributioninstall

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func canonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real, nil
	}
	parent := filepath.Dir(abs)
	if parent == abs {
		return "", errors.New("installation_path_unavailable")
	}
	real, err := canonical(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(real, filepath.Base(abs)), nil
}
func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	actual, err := filepath.EvalSymlinks(path)
	if err != nil || actual != path {
		return errors.New("installation_directory_untrusted")
	}
	return nil
}
func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	h := sha256.New()
	if _, err = io.Copy(h, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".aih-publish-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(mode); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	e := file.Close()
	if err != nil {
		return err
	}
	if e != nil {
		return e
	}
	return replaceFile(file.Name(), path)
}
func atomicJSON(path string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(raw, '\n'), 0600)
}
func copyFile(source, target string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(target), ".aih-copy-*")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	if err = out.Chmod(mode); err == nil {
		_, err = io.Copy(out, in)
	}
	if err == nil {
		err = out.Sync()
	}
	e := out.Close()
	if err != nil {
		return err
	}
	if e != nil {
		return e
	}
	return replaceFile(out.Name(), target)
}
func snapshotFile(path, backupDir string) (fileRecord, error) {
	r := fileRecord{Path: path}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	r.Exists = true
	if info.Mode()&os.ModeSymlink != 0 {
		r.Symlink, err = os.Readlink(path)
		return r, err
	}
	if !info.Mode().IsRegular() {
		return r, errors.New("installation_file_untrusted")
	}
	name := sha256.Sum256([]byte(path))
	r.Backup = filepath.Join(backupDir, hex.EncodeToString(name[:])+".saved")
	if err = copyFile(path, r.Backup, 0600); err != nil {
		return r, err
	}
	r.SHA256, err = hashFile(r.Backup)
	return r, err
}
func restoreFile(r fileRecord) error {
	if !r.Exists {
		if err := os.Remove(r.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if r.Symlink != "" {
		tmp := r.Path + ".restore-" + time.Now().UTC().Format("150405.000000000")
		if err := os.Symlink(r.Symlink, tmp); err != nil {
			return err
		}
		defer os.Remove(tmp)
		return replaceFile(tmp, r.Path)
	}
	hash, err := hashFile(r.Backup)
	if err != nil || hash != r.SHA256 {
		return errors.New("installation_backup_changed")
	}
	return copyFile(r.Backup, r.Path, 0700)
}
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
