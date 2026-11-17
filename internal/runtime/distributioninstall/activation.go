package distributioninstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/serveridentity"
)

// AwaitActivation runs before the daemon opens any business store or starts a
// background writer. The installer can prove its service/executable is alive
// without exposing a half-committed data upgrade to requests or refreshers.
func AwaitActivation(ctx context.Context, home, address string, listen func(context.Context, string, string) (net.Listener, error), out io.Writer) error {
	pending := filepath.Join(home, "run", "distribution-install-pending.json")
	raw, err := os.ReadFile(pending)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var marker struct {
		Journal string `json:"journal"`
	}
	if json.Unmarshal(raw, &marker) != nil || !within(transactionRoot(home), marker.Journal) {
		return errors.New("installation_activation_record_invalid")
	}
	var j journal
	data, err := os.ReadFile(marker.Journal)
	if err != nil || json.Unmarshal(data, &j) != nil || j.Home != home {
		return errors.New("installation_activation_record_invalid")
	}
	if j.Phase == "complete" {
		return nil
	}
	if j.Phase != "activating" {
		return errors.New("安装未提交，正在等待安装器恢复；未打开用户数据")
	}
	listener, err := listen(ctx, "tcp", address)
	if err != nil {
		return err
	}
	release, err := serveridentity.Publish(home, listener.Addr())
	if err != nil {
		listener.Close()
		return err
	}
	defer release()
	server := &http.Server{ReadHeaderTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": "aih-server", "ready": false, "installation": "awaiting_commit"})
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "installation_in_progress", "message": "AIH 正在完成更新，请稍后重试"})
	})}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	defer server.Close()
	fmt.Fprintln(out, "aih-server installation activation waiting on http://"+listener.Addr().String())
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case e := <-done:
			if !errors.Is(e, http.ErrServerClosed) {
				return e
			}
			return nil
		case <-ticker.C:
			if _, err := os.Stat(pending); os.IsNotExist(err) {
				_ = server.Close()
				<-done
				return nil
			}
			raw, err := os.ReadFile(marker.Journal)
			if err != nil {
				return err
			}
			if json.Unmarshal(raw, &j) != nil {
				return errors.New("installation_activation_record_invalid")
			}
			if j.Phase == "complete" {
				_ = server.Close()
				<-done
				return nil
			}
			if j.Phase == "rolled_back" {
				return errors.New("installation_rolled_back")
			}
		}
	}
}
