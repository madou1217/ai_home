package distributioninstall

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
	"github.com/madou1217/ai_home/internal/runtime/distributiondata"
	_ "modernc.org/sqlite"
)

var dataFiles = []string{"aih.db", "aih.db-wal", "aih.db-shm", "aih.db-journal"}

func normalize(o Options) (Options, error) {
	var err error
	if o.HostHome == "" {
		o.HostHome, err = os.UserHomeDir()
		if err != nil {
			return o, err
		}
	}
	o.HostHome, err = canonical(o.HostHome)
	if err != nil {
		return o, err
	}
	if o.Home == "" {
		o.Home = os.Getenv("AIH_HOME_DIR")
	}
	if o.Home == "" {
		o.Home = filepath.Join(o.HostHome, ".ai_home")
	}
	o.Home, err = canonical(o.Home)
	if err != nil {
		return o, err
	}
	if o.Home == o.HostHome || o.Home == filepath.VolumeName(o.Home)+string(filepath.Separator) {
		return o, errors.New("安装数据目录无效")
	}
	o.PackageRoot, err = canonical(o.PackageRoot)
	if err != nil {
		return o, err
	}
	if o.BinDir == "" {
		if runtime.GOOS == "windows" {
			o.BinDir = filepath.Join(o.HostHome, "AppData", "Local", "aih")
		} else {
			o.BinDir = filepath.Join(o.HostHome, ".local", "bin")
		}
	}
	o.BinDir, err = canonical(o.BinDir)
	if err != nil {
		return o, err
	}
	if o.Output == nil {
		o.Output = io.Discard
	}
	if err = privateDir(o.Home); err != nil {
		return o, err
	}
	if err = privateDir(filepath.Join(o.Home, "run")); err != nil {
		return o, err
	}
	return o, nil
}
func receiptPath(home string) string     { return filepath.Join(home, "distribution-install.json") }
func transactionRoot(home string) string { return home + ".install-history" }

// pruneInstallHistory keeps only the current transaction backup after a
// verified upgrade and removes earlier completed transactions. Only journals
// that prove a successful install of this home are eligible: recovery, unknown
// or rolled-back transactions and unrelated directories are never removed.
// Set AIH_INSTALL_PRUNE_COMPLETED_BACKUPS=0 to retain every backup.
func pruneInstallHistory(home, keep string) {
	pruneInstallHistoryInto(home, keep, &pruneCollector{report: &PruneReport{}})
}

// pruneInstallHistoryInto is the report-producing form of pruneInstallHistory.
// An empty keep path means the authoritative transaction is unknown, so nothing
// is removed.
func pruneInstallHistoryInto(home, keep string, collector *pruneCollector) {
	if collector == nil || strings.TrimSpace(keep) == "" {
		return
	}
	if os.Getenv("AIH_INSTALL_PRUNE_COMPLETED_BACKUPS") == "0" {
		return
	}
	root := transactionRoot(home)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if filepath.Clean(path) == filepath.Clean(keep) {
			collector.keep(path)
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(path, "journal.json"))
		if err != nil || len(raw) > 4<<20 {
			continue
		}
		var previous journal
		if json.Unmarshal(raw, &previous) != nil || previous.Version != 1 || previous.ID != entry.Name() || previous.Home != home || previous.Phase != "complete" {
			continue
		}
		collector.drop(path, dirSize(path))
	}
}
func launcherTarget(o Options) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(o.BinDir, "aih.exe")
	}
	return filepath.Join(o.BinDir, "aih")
}
func randomID() string { var raw [12]byte; _, _ = rand.Read(raw[:]); return hex.EncodeToString(raw[:]) }
func Install(ctx context.Context, options Options) (result Result, resultErr error) {
	o, err := normalize(options)
	if err != nil {
		return result, err
	}
	build, err := ReadBuild(o.PackageRoot)
	if err != nil {
		return result, err
	}
	if o.Launcher == "" {
		name := "aih"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		o.Launcher = filepath.Join(o.PackageRoot, name)
	}
	o.Launcher, err = canonical(o.Launcher)
	if err != nil {
		return result, err
	}
	if info, err := os.Stat(o.Launcher); err != nil || !info.Mode().IsRegular() {
		return result, errors.New("发行包启动器不存在")
	}
	if !within(filepath.Join(o.Home, "pkg"), o.PackageRoot) {
		originalRoot := o.PackageRoot
		stableRoot, stageErr := stagePortableBundle(ctx, o, build)
		if stageErr != nil {
			return result, stageErr
		}
		if within(originalRoot, o.Launcher) {
			relative, _ := filepath.Rel(originalRoot, o.Launcher)
			o.Launcher = filepath.Join(stableRoot, relative)
		}
		o.PackageRoot = stableRoot
	}
	lock, err := os.OpenFile(filepath.Join(o.Home, "run", "distribution-install.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return result, err
	}
	defer lock.Close()
	if err = lockFile(lock); err != nil {
		return result, errors.New("另一次安装或更新正在进行")
	}
	defer unlockFile(lock)
	marker := filepath.Join(o.Home, "run", "distribution-install-pending.json")
	if raw, e := os.ReadFile(marker); e == nil {
		var previous struct {
			Journal string `json:"journal"`
		}
		if json.Unmarshal(raw, &previous) != nil || !within(transactionRoot(o.Home), previous.Journal) {
			return result, errors.New("上次安装恢复记录无效，已保留原数据")
		}
		if err = recoverJournal(ctx, o, previous.Journal); err != nil {
			return result, err
		}
		result.Recovered = true
	}
	busy, why := false, ""
	if !o.Service {
		if _, e := os.Stat(filepath.Join(o.Home, "run", "go-server-runtime.json")); e == nil {
			c := readConfig(o.Home)
			if c.readError != nil {
				return result, c.readError
			}
			if listenerPresent(c.Port) {
				return result, errors.New("已有后台服务运行；请使用普通安装以安全更新，不支持对运行实例使用 --no-service")
			}
		}
	}
	if o.Service {
		busy, why, err = Busy(ctx, o.Home)
		if err != nil {
			return result, err
		}
	}
	if busy {
		return result, fmt.Errorf("暂不安装：%s；请结束任务后重试或预约稍后安装", why)
	}
	if err = checkSpace(o); err != nil {
		return result, err
	}
	tx := filepath.Join(transactionRoot(o.Home), time.Now().UTC().Format("20060102T150405Z")+"-"+randomID())
	if err = privateDir(tx); err != nil {
		return result, err
	}
	backupDir := filepath.Join(tx, "host-backup")
	if err = privateDir(backupDir); err != nil {
		return result, err
	}
	j := journal{ServiceRequested: o.Service, Version: 1, ID: filepath.Base(tx), Phase: "prepared", Home: o.Home, Target: launcherTarget(o), PackageRoot: o.PackageRoot}
	if err = verifyLauncherOwnership(o, j.Target); err != nil {
		return result, err
	}
	j.PreviousLauncher, err = snapshotFile(j.Target, backupDir)
	if err != nil {
		return result, err
	}
	j.PreviousBinding, err = snapshotFile(j.Target+".package.json", backupDir)
	if err != nil {
		return result, err
	}
	j.PreviousReceipt, err = snapshotFile(receiptPath(o.Home), backupDir)
	if err != nil {
		return result, err
	}
	h := platformHooks{}
	if o.Service {
		j.Service, err = h.Snapshot(ctx, o, backupDir)
		if err != nil {
			return result, err
		}
	}
	jp := filepath.Join(tx, "journal.json")
	if err = atomicJSON(jp, j); err != nil {
		return result, err
	}
	if err = atomicJSON(marker, map[string]string{"journal": jp}); err != nil {
		return result, err
	}
	// The rollback guard is installed before any service or data mutation.
	defer func() {
		if resultErr == nil || j.Phase == "complete" {
			return
		}
		j.Error = resultErr.Error()
		_ = atomicJSON(jp, j)
		rollbackErr := rollback(context.WithoutCancel(ctx), o, &j, jp)
		if rollbackErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("原版本恢复未完成，备份保留于 %s: %w", tx, rollbackErr))
		} else {
			resultErr = fmt.Errorf("安装未完成，原版本及数据已恢复（%s）: %w", tx, resultErr)
		}
	}()
	fmt.Fprintln(o.Output, "[aih] 正在保存旧版本并安全停止后台服务…")
	if o.Service {
		if err = h.Stop(ctx, o, j.Service); err != nil {
			return result, err
		}
	}
	j.Phase = "stopped"
	if err = atomicJSON(jp, j); err != nil {
		return result, err
	}
	writer, err := accountwriterlease.Acquire(o.Home)
	if err != nil {
		return result, errors.New("仍有 AIH 数据写入者，已停止更新")
	}
	defer writer.Close()
	fmt.Fprintln(o.Output, "[aih] 正在备份并自动升级用户数据…")
	data, err := distributiondata.Prepare(ctx, distributiondata.Options{Home: o.Home, BackupDir: tx})
	j.Data = &data
	if err != nil {
		return result, err
	}
	if err = bootstrapConfig(ctx, data.PreparedHome, o.Home); err != nil {
		return result, err
	}
	if err = distributiondata.VerifySource(ctx, data.SourceFingerprint); err != nil {
		return result, err
	}
	j.Phase = "publishing"
	if err = atomicJSON(jp, j); err != nil {
		return result, err
	}
	displaced := filepath.Join(tx, "displaced")
	if err = privateDir(displaced); err != nil {
		return result, err
	}
	for _, name := range dataFiles {
		path := filepath.Join(o.Home, name)
		if _, e := os.Lstat(path); os.IsNotExist(e) {
			continue
		} else if e != nil {
			return result, e
		}
		j.Displaced = append(j.Displaced, name)
		if err = atomicJSON(jp, j); err != nil {
			return result, err
		}
		if err = replaceFile(path, filepath.Join(displaced, name)); err != nil {
			return result, err
		}
	}
	for _, name := range []string{"aih.db"} {
		source := filepath.Join(data.PreparedHome, name)
		if _, e := os.Stat(source); os.IsNotExist(e) {
			continue
		} else if e != nil {
			return result, e
		}
		j.Published = append(j.Published, name)
		if err = atomicJSON(jp, j); err != nil {
			return result, err
		}
		if err = copyFile(source, filepath.Join(o.Home, name), 0600); err != nil {
			return result, err
		}
	}
	if err = os.MkdirAll(o.BinDir, 0700); err != nil {
		return result, err
	}
	if err = publishLauncher(o, j.Target); err != nil {
		return result, err
	}
	o.Launcher = j.Target
	receipt := Receipt{Version: 1, State: "activating", Home: o.Home, HostHome: o.HostHome, PackageRoot: o.PackageRoot, Executable: bundleServer(o.PackageRoot), Launcher: j.Target, BinarySHA256: build.GoCore.SHA256, ReleaseVersion: build.Version, SourceSHA: build.SourceSHA, Target: build.Target, InstalledAt: time.Now().UTC(), Transaction: jp, Service: o.Service}
	if info, e := os.Lstat(j.Target); e == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			receipt.LauncherLink, _ = os.Readlink(j.Target)
		} else {
			receipt.LauncherSHA256, _ = hashFile(j.Target)
		}
	}
	if err = atomicJSON(receiptPath(o.Home), receipt); err != nil {
		return result, err
	}
	// The new daemon owns the same writer lock; release only after all files and
	// its receipt are published. Data gates reject interrupted two-file publish.
	if err = writer.Close(); err != nil {
		return result, err
	}
	j.Phase = "activating"
	if err = atomicJSON(jp, j); err != nil {
		return result, err
	}
	if o.Service {
		fmt.Fprintln(o.Output, "[aih] 正在恢复后台服务并验证新版本…")
		if err = h.Install(ctx, o); err != nil {
			return result, err
		}
		if err = verifyStarted(ctx, o, build); err != nil {
			return result, err
		}
	}

	// Commit before removing the admission marker. Subsequent housekeeping
	// failures may be retried, but never roll back data after users can write.
	committed := j
	committed.Phase = "complete"
	if err = atomicJSON(jp, committed); err != nil {
		return result, err
	}
	j = committed
	receipt.State = "installed"
	if err = atomicJSON(receiptPath(o.Home), receipt); err != nil {
		return result, err
	}
	if err = os.Remove(marker); err != nil && !os.IsNotExist(err) {
		fmt.Fprintln(o.Output, "[aih] 安装已提交，清理记录将在下次启动恢复。")
	}

	if o.Service {
		if err = verifyRunningCommitted(ctx, o, build); err != nil {
			return result, err
		}
	}
	result.OK = true
	result.Receipt = receipt
	result.Message = "安装完成，账号、配置和会话数据已保留"
	// 升级成功后只留本次备份用于回滚，旧的安装前备份自动清理，避免无限占盘。
	pruneInstallHistory(o.Home, tx)
	// 发行垃圾回收：只保留当前版本与相邻一份旧版本，更早的版本目录与过期安装包当场删除。
	if gcReport, gcErr := PruneArtifactsLocked(PruneOptions{Home: o.Home, MinAge: 10 * time.Minute, DedupeSameVersion: true}); gcErr == nil && len(gcReport.Removed) > 0 {
		fmt.Fprintf(o.Output, "[aih] 已清理 %d 份历史发行文件（释放 %d MB）\n", len(gcReport.Removed), gcReport.FreedBytes/(1<<20))
	}
	fmt.Fprintf(o.Output, "[aih] %s（%s）\n", result.Message, build.Version)
	return result, nil
}
func bootstrapConfig(ctx context.Context, prepared, oldHome string) error {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(prepared, "aih.db"))+"?mode=rw")
	if err != nil {
		return err
	}
	defer db.Close()
	raw, found, err := appstate.ReadRawKVStrict(ctx, db, appstate.KeyServerConfig)
	if err != nil {
		return err
	}
	m := map[string]any{}
	if found && json.Unmarshal([]byte(raw), &m) != nil {
		return errors.New("已有服务配置损坏，未覆盖")
	}
	if len(m) == 0 {
		if legacy, e := os.ReadFile(filepath.Join(oldHome, "server-config.json")); e == nil {
			if json.Unmarshal(bytes.TrimPrefix(legacy, []byte{0xef, 0xbb, 0xbf}), &m) != nil {
				return errors.New("旧服务配置损坏，未覆盖")
			}
		}
	}
	secret := func(prefix string) string {
		var b [32]byte
		_, _ = rand.Read(b[:])
		return prefix + hex.EncodeToString(b[:])
	}
	for _, key := range []string{"apiKey", "managementKey"} {
		if x, ok := m[key].(string); !ok || strings.TrimSpace(x) == "" {
			prefix := ""
			if key == "apiKey" {
				prefix = "sk-"
			}
			m[key] = secret(prefix)
		}
	}
	if m["port"] == nil {
		m["port"] = serverconfig.DefaultPort
	}
	if m["host"] == nil {
		m["host"] = serverconfig.DefaultHost
	}
	m["goCoreEnabled"] = true
	out, _ := json.Marshal(m)
	if err := appstate.WriteRawKV(ctx, db, appstate.KeyServerConfig, string(out), time.Now().UnixMilli()); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}
func verifyLauncherOwnership(o Options, target string) error {
	info, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var old Receipt
	raw, _ := os.ReadFile(receiptPath(o.Home))
	if json.Unmarshal(raw, &old) == nil && old.Version == 1 && filepath.Clean(old.Launcher) == filepath.Clean(target) {
		if old.LauncherLink != "" {
			link, e := os.Readlink(target)
			if e == nil && link == old.LauncherLink {
				return nil
			}
			return errors.New("已有 AIH 启动器已被更改，未覆盖")
		}
		if old.LauncherSHA256 != "" {
			hash, e := hashFile(target)
			if e == nil && hash == old.LauncherSHA256 {
				return nil
			}
			return errors.New("已有 AIH 启动器已被更改，未覆盖")
		}
		// Old receipts without an identity are not replacement authority.
	}
	if info.Mode()&os.ModeSymlink != 0 {
		real, err := filepath.EvalSymlinks(target)
		if err == nil && within(filepath.Join(o.Home, "pkg"), real) {
			if _, err = ReadBuild(filepath.Dir(real)); err == nil {
				return nil
			}
		}
	}
	// Legacy SFX is self-identifying without executing arbitrary target code.
	if info.Mode().IsRegular() {
		f, err := os.Open(target)
		if err != nil {
			return err
		}
		defer f.Close()
		content, err := io.ReadAll(io.LimitReader(f, 256<<20))
		if err != nil {
			return err
		}
		if bytes.Contains(content, []byte("AIH_PKG_EXTRACT_ONLY")) && bytes.Contains(content, []byte(".aih-package.json")) {
			return nil
		}
	}
	return errors.New("目标 aih 命令不属于已验证的 AIH 安装；未覆盖，请选择其他安装目录")
}
func publishLauncher(o Options, target string) error {
	source, err := filepath.Abs(o.Launcher)
	if err != nil {
		return err
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	build, err := ReadBuild(o.PackageRoot)
	if err != nil {
		return err
	}
	if err = atomicJSON(targetAbs+".package.json", map[string]any{"version": 1, "home": o.Home, "packageRoot": o.PackageRoot, "serverSha256": build.GoCore.SHA256}); err != nil {
		return err
	}
	if source == targetAbs {
		return nil
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" && strings.HasPrefix(string(data[:min(len(data), 16)]), "#!") {
		quote := func(x string) string { return "'" + strings.ReplaceAll(x, "'", "'\"'\"'") + "'" }
		wrapper := "#!/bin/sh\n# aih-distribution-installed\nif [ -z \"$AIH_HOME_DIR\" ]; then AIH_HOME_DIR=" + quote(o.Home) + "; export AIH_HOME_DIR; fi\nexec " + quote(source) + " \"$@\"\n"
		return atomicWrite(targetAbs, []byte(wrapper), 0755)
	}
	return copyFile(source, targetAbs, 0755)
}
