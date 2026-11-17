package distributiondata

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type layout struct{ root, capture, scratch string }

func allocate(opts Options, report *Report) (layout, error) {
	if opts.Home == "" || opts.BackupDir == "" {
		return layout{}, errors.New("distributiondata: Home and BackupDir are required")
	}
	home, err := resolvedPath(opts.Home)
	if err != nil {
		return layout{}, err
	}
	parent, err := resolvedPath(opts.BackupDir)
	if err != nil {
		return layout{}, err
	}
	if within(home, parent) {
		return layout{}, errors.New("distributiondata: transaction directory must be outside live Home")
	}
	if err := os.MkdirAll(parent, 0700); err != nil {
		return layout{}, err
	}
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil || resolved != parent {
		return layout{}, errors.New("distributiondata: transaction directory changed during preparation")
	}
	root, err := os.MkdirTemp(parent, "data-preparation-")
	if err != nil {
		return layout{}, err
	}
	report.Home = home
	report.PreparedHome = filepath.Join(root, "prepared")
	report.BackupHome = filepath.Join(root, "backup")
	report.OriginalBackup = filepath.Join(root, "original")
	report.ReportPath = filepath.Join(root, "report.json")
	report.FingerprintPath = filepath.Join(root, "source-fingerprint.json")
	l := layout{root, filepath.Join(root, "capture"), filepath.Join(root, "scratch")}
	for _, dir := range []string{report.PreparedHome, report.BackupHome, report.OriginalBackup, l.capture, l.scratch} {
		if err := os.Mkdir(dir, 0700); err != nil {
			return l, err
		}
	}
	return l, syncDir(parent)
}

// Resolve even a not-yet-created home through its nearest existing ancestor.
func resolvedPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	current := absolute
	var tail []string
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, tail[i])
			}
			return resolved, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		tail = append(tail, filepath.Base(current))
		current = parent
	}
}

func within(parent, child string) bool {
	// Default macOS and Windows volumes are case-insensitive. Conservative
	// rejection is preferable to accidentally staging inside the live home.
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		parent, child = strings.ToLower(parent), strings.ToLower(child)
	}
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func copyPrivate(ctx context.Context, source, target string) (resultErr error) {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, in.Close()) }()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, out.Close()) }()
	if _, err := io.Copy(out, contextReader{ctx, in}); err != nil {
		return err
	}
	return out.Sync()
}

func writeJSON(path string, value any) (resultErr error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
