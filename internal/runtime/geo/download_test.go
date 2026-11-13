package geo

import (
	"bytes"
	"compress/gzip"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(raw); err != nil {
		t.Fatalf("gzip 写入失败: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip 关闭失败: %v", err)
	}
	return buf.Bytes()
}

func sampleMMDBPayload() []byte {
	payload := append([]byte("fake-mmdb-tree-data"), mmdbMetadataMarker...)
	return append(payload, []byte("metadata-tail")...)
}

func TestDownloadDBIPCitySuccessAndFallbackPrevMonth(t *testing.T) {
	t.Parallel()
	validGz := gzipBytes(t, sampleMMDBPayload())
	var requestedPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPaths = append(requestedPaths, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "dbip-city-lite-2026-11.mmdb.gz") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if strings.HasSuffix(r.URL.Path, "dbip-city-lite-2026-10.mmdb.gz") {
			w.Header().Set("Content-Type", "application/gzip")
			_, _ = w.Write(validGz)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	aiHome := t.TempDir()
	var phases []string
	res := DownloadDBIPCity(context.Background(), DownloadOptions{
		AIHomeDir:   aiHome,
		URLTemplate: server.URL + "/dbip-city-lite-%s.mmdb.gz",
		HTTPClient:  server.Client(),
		Now:         func() time.Time { return time.Date(2026, 11, 13, 5, 0, 0, 0, time.UTC) },
		OnProgress: func(progress DownloadProgress) {
			phases = append(phases, progress.Phase)
		},
	})
	if !res.OK {
		t.Fatalf("DownloadDBIPCity() 失败 = %+v", res)
	}
	if res.Month != "2026-10" {
		t.Errorf("Month = %q，期望 2026-10", res.Month)
	}
	if len(requestedPaths) != 2 {
		t.Errorf("请求路径 = %v，期望先试 2026-11 再回退 2026-10", requestedPaths)
	}
	target := ManagedDBIPPath(aiHome)
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取落盘文件失败: %v", err)
	}
	if !bytes.Equal(data, sampleMMDBPayload()) {
		t.Errorf("落盘内容不匹配")
	}
	resources := ListResources(aiHome)
	if len(resources) != 1 || !resources[0].Installed || resources[0].Bytes != int64(len(data)) {
		t.Errorf("ListResources() = %+v", resources)
	}
	if len(phases) == 0 || phases[len(phases)-1] != "done" {
		t.Errorf("进度回调未包含 done: %v", phases)
	}
}

func TestDownloadDBIPCityRejectsInvalidMMDBWithoutClobbering(t *testing.T) {
	t.Parallel()
	badGz := gzipBytes(t, []byte("<html>not a maxmind db</html>"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(badGz)
	}))
	defer server.Close()

	aiHome := t.TempDir()
	existing := ManagedDBIPPath(aiHome)
	if err := os.MkdirAll(filepath.Dir(existing), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existing, []byte("previous-good"), 0o600); err != nil {
		t.Fatal(err)
	}

	res := DownloadDBIPCity(context.Background(), DownloadOptions{
		AIHomeDir:   aiHome,
		URLTemplate: server.URL + "/dbip-city-lite-%s.mmdb.gz",
		HTTPClient:  server.Client(),
	})
	if res.OK || res.Error != "geo_download_invalid_mmdb" {
		t.Fatalf("结果 = %+v，期望 geo_download_invalid_mmdb", res)
	}
	got, err := os.ReadFile(existing)
	if err != nil || string(got) != "previous-good" {
		t.Errorf("既有合法文件被破坏: %q err=%v", string(got), err)
	}
}
