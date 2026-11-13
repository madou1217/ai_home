package geo

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// maxDecompressedBytes 限制解压后最大体积（300MB），防止恶意畸形包打爆磁盘。
	maxDecompressedBytes = 300 * 1024 * 1024
	defaultHTTPTimeout   = 5 * time.Minute
	mmdbMetadataTailRead = 128 * 1024
	progressEmitInterval = 128 * 1024
)

var mmdbMetadataMarker = []byte("\xab\xcd\xefMaxMind.com")

// DownloadProgress 描述下载与解压过程中的进度更新。
type DownloadProgress struct {
	Phase         string
	ReceivedBytes int64
	TotalBytes    int64
	Percent       int
}

// DownloadOptions 配置 DownloadDBIPCity 的路径、时钟、HTTP 客户端与回调。
type DownloadOptions struct {
	AIHomeDir   string
	URLTemplate string
	HTTPClient  *http.Client
	Now         func() time.Time
	OnProgress  func(DownloadProgress)
}

// DownloadResult 返回一次 DB-IP 下载操作的结果。
type DownloadResult struct {
	OK    bool
	Month string
	Path  string
	Bytes int64
	Error string
}

// DownloadDBIPCity 从 DB-IP 公开源下载当月（或回退上月）的 City Lite .mmdb.gz，
// 流式解压到临时文件、校验 MaxMind MMDB 尾标后原子替换 <aiHome>/geo/dbip-city-lite.mmdb。
func DownloadDBIPCity(ctx context.Context, options DownloadOptions) DownloadResult {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	if aiHomeDir == "" {
		return DownloadResult{Error: "geo_ai_home_missing"}
	}
	targetPath := ManagedDBIPPath(aiHomeDir)
	urlTemplate := strings.TrimSpace(options.URLTemplate)
	if urlTemplate == "" {
		urlTemplate = DBIPURLTemplate
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: defaultHTTPTimeout}
	}

	months := monthCandidates(nowFn().UTC())
	lastError := "geo_download_failed"
	for _, month := range months {
		if ctx.Err() != nil {
			return DownloadResult{Error: "geo_download_cancelled"}
		}
		downloadURL := fmt.Sprintf(urlTemplate, month)
		res := downloadAndExtractMonth(ctx, client, downloadURL, targetPath, options.OnProgress)
		if res.OK {
			res.Month = month
			return res
		}
		if res.Error == "geo_download_cancelled" {
			return res
		}
		lastError = res.Error
	}
	return DownloadResult{Error: lastError}
}

func monthCandidates(nowUTC time.Time) []string {
	current := time.Date(nowUTC.Year(), nowUTC.Month(), 1, 0, 0, 0, 0, time.UTC)
	prev := current.AddDate(0, -1, 0)
	return []string{current.Format("2006-01"), prev.Format("2006-01")}
}

func downloadAndExtractMonth(
	ctx context.Context,
	client *http.Client,
	downloadURL string,
	targetPath string,
	onProgress func(DownloadProgress),
) DownloadResult {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	if err != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_download_request_invalid:%v", err)}
	}
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return DownloadResult{Error: "geo_download_cancelled"}
		}
		return DownloadResult{Error: fmt.Sprintf("geo_download_failed:%v", err)}
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return DownloadResult{Error: fmt.Sprintf("geo_download_http_%d", response.StatusCode)}
	}

	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_dir_create_failed:%v", err)}
	}
	tmpPath := fmt.Sprintf("%s.tmp.%d.%d", targetPath, os.Getpid(), time.Now().UnixNano())
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	tmpFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_tmp_open_failed:%v", err)}
	}

	counter := &progressReader{
		reader:     response.Body,
		totalBytes: response.ContentLength,
		onProgress: onProgress,
	}
	gzReader, err := gzip.NewReader(counter)
	if err != nil {
		_ = tmpFile.Close()
		return DownloadResult{Error: "geo_download_invalid_gzip"}
	}

	limited := io.LimitReader(gzReader, maxDecompressedBytes+1)
	written, copyErr := io.Copy(tmpFile, limited)
	_ = gzReader.Close()
	closeErr := tmpFile.Close()

	if copyErr != nil {
		if errors.Is(copyErr, context.Canceled) || ctx.Err() != nil {
			return DownloadResult{Error: "geo_download_cancelled"}
		}
		return DownloadResult{Error: fmt.Sprintf("geo_download_extract_failed:%v", copyErr)}
	}
	if closeErr != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_tmp_close_failed:%v", closeErr)}
	}
	if written > maxDecompressedBytes {
		return DownloadResult{Error: "geo_download_too_large"}
	}
	if !looksLikeMMDB(tmpPath) {
		return DownloadResult{Error: "geo_download_invalid_mmdb"}
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_chmod_failed:%v", err)}
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return DownloadResult{Error: fmt.Sprintf("geo_rename_failed:%v", err)}
	}
	cleanupTmp = false
	if onProgress != nil {
		onProgress(DownloadProgress{
			Phase:         "done",
			ReceivedBytes: counter.received,
			TotalBytes:    response.ContentLength,
			Percent:       100,
		})
	}
	return DownloadResult{
		OK:    true,
		Path:  targetPath,
		Bytes: written,
	}
}

func looksLikeMMDB(filePath string) bool {
	file, err := os.Open(filePath)
	if err != nil {
		return false
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || info.Size() <= int64(len(mmdbMetadataMarker)) {
		return false
	}
	tailSize := info.Size()
	if tailSize > mmdbMetadataTailRead {
		tailSize = mmdbMetadataTailRead
	}
	offset := info.Size() - tailSize
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return false
	}
	buf := make([]byte, tailSize)
	n, err := io.ReadFull(file, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	return bytes.Contains(buf[:n], mmdbMetadataMarker)
}

type progressReader struct {
	reader       io.Reader
	totalBytes   int64
	received     int64
	lastEmitted  int64
	onProgress   func(DownloadProgress)
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.received += int64(n)
		if pr.onProgress != nil && (pr.received-pr.lastEmitted >= progressEmitInterval || err == io.EOF) {
			pr.lastEmitted = pr.received
			percent := 0
			if pr.totalBytes > 0 {
				percent = int(pr.received * 100 / pr.totalBytes)
				if percent > 100 {
					percent = 100
				}
			}
			pr.onProgress(DownloadProgress{
				Phase:         "downloading",
				ReceivedBytes: pr.received,
				TotalBytes:    pr.totalBytes,
				Percent:       percent,
			})
		}
	}
	return n, err
}
