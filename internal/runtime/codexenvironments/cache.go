package codexenvironments

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// 探测结果缓存。
//
// 探测很贵（单条可用连接约 5s，慢链路更久），而 CLI 进程通常只活一两秒——
// 放在后台 goroutine 里会被进程退出杀掉，功能等于没有。所以把上次探测结果
// 落盘缓存：命中时直接写文件（毫秒级），只有缓存过期才真的去连 SSH。
//
// 缓存只存「结论」，不存凭据、不存命令输出。

const (
	cacheFileName = "codex-environments-probe.json"
	// cacheTTL 是探测结论的可信时长。SSH 主机的可用性变化远慢于这个窗口，
	// 而每次启动都重探会让 CLI 变慢。
	cacheTTL = 10 * time.Minute
	// cacheVersion 变更会丢弃旧结论；探测语义改动（如区分可达与缺 codex）
	// 必须递增，否则旧缓存里的误判会继续沿用。
	cacheVersion = 2
)

type probeCache struct {
	Version   int           `json:"version"`
	UpdatedAt int64         `json:"updatedAt"`
	Probes    []ProbeResult `json:"probes"`
}

func cachePath(aiHomeDir string) string {
	return filepath.Join(aiHomeDir, "run", cacheFileName)
}

// LoadCache 读取缓存；过期、损坏或版本不符时 ok=false。
func LoadCache(aiHomeDir string, now time.Time) ([]ProbeResult, bool) {
	if aiHomeDir == "" {
		return nil, false
	}
	raw, err := os.ReadFile(cachePath(aiHomeDir))
	if err != nil {
		return nil, false
	}
	var cache probeCache
	if err := json.Unmarshal(raw, &cache); err != nil {
		return nil, false
	}
	if cache.Version != cacheVersion || len(cache.Probes) == 0 {
		return nil, false
	}
	age := now.Sub(time.UnixMilli(cache.UpdatedAt))
	if age < 0 || age > cacheTTL {
		return nil, false
	}
	return cache.Probes, true
}

// SaveCache 原子写入探测结论；失败只影响下次是否重探，不影响功能。
func SaveCache(aiHomeDir string, probes []ProbeResult, now time.Time) error {
	if aiHomeDir == "" || len(probes) == 0 {
		return nil
	}
	path := cachePath(aiHomeDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(probeCache{
		Version:   cacheVersion,
		UpdatedAt: now.UnixMilli(),
		Probes:    probes,
	})
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".aih-probe-cache-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
