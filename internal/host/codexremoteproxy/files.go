package codexremoteproxy

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

func writeReady(file string, value any) error {
	if file == "" {
		return nil
	}
	if info, err := os.Lstat(file); err == nil && (info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular()) {
		return errors.New("remote_proxy_ready_path_invalid")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	out, err := os.CreateTemp(filepath.Dir(file), ".aih-remote-ready-*")
	if err != nil {
		return err
	}
	name := out.Name()
	defer os.Remove(name)
	if err = out.Chmod(0600); err == nil {
		_, err = out.Write(append(raw, '\n'))
	}
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, file)
}

// Trace remains optional, redacted and bounded. No token/body payload is added
// to diagnostics; retaining older bytes never requires reading the whole log.
func traceWriter(file string) func(map[string]any) {
	if file == "" {
		return nil
	}
	var mu sync.Mutex
	return func(entry map[string]any) {
		entry["at"] = time.Now().UTC().Format(time.RFC3339Nano)
		entry["component"] = "codex_remote_control_proxy"
		raw, err := json.Marshal(entry)
		if err != nil || len(raw) > 64<<10 {
			return
		}
		line := []byte(codexappserverapi.SanitizeTraceText(string(raw), 64<<10) + "\n")
		mu.Lock()
		defer mu.Unlock()
		if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			return
		}
		info, statErr := os.Lstat(file)
		if statErr == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
			return
		}
		if statErr == nil && info.Size()+int64(len(line)) > 10<<20 {
			// Own at most one prior segment; never follow a symlink as backup.
			backup := file + ".1"
			if old, e := os.Lstat(backup); e == nil && !old.Mode().IsRegular() {
				return
			}
			_ = os.Remove(backup)
			if os.Rename(file, backup) != nil {
				return
			}
		}
		out, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			return
		}
		defer out.Close()
		_ = out.Chmod(0600)
		_, _ = out.Write(line)
	}
}
