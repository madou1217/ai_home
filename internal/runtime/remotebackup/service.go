package remotebackup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// BackupLogger 接收远程备份日志与非致命告警。
type BackupLogger interface {
	Info(message string)
	Warn(message string)
}

// StrategyFactory 为单个目标创建备份策略实例（连接、读写远端清单与账号文件）。
type StrategyFactory func(target BackupTarget, onHostKey func(fingerprint string)) (Strategy, error)

// ServiceOptions 配置单轮远程备份所需的文件系统路径、导出器与传输工厂。
type ServiceOptions struct {
	AIHomeDir      string
	Exporter       AccountExporter
	CreateStrategy StrategyFactory
	HostName       string
	Now            func() time.Time
	Env            func(string) string
	HomeDir        string
	Logger         BackupLogger
}

// RunOptions 配置单次 RunRemoteBackup 执行的参数。
type RunOptions struct {
	TargetIDs []string
	Full      bool
	Config    *BackupConfig
	State     *BackupState
}

// TargetBackupResult 描述单个目标的执行结果。
type TargetBackupResult struct {
	TargetID  string `json:"targetId"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Uploaded  int    `json:"uploaded"`
	Unchanged int    `json:"unchanged"`
	Deleted   int    `json:"deleted"`
	Revision  int    `json:"revision,omitempty"`
	Total     int    `json:"total,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
}

// BackupRunResult 描述一轮多目标远程备份或调度决策的汇总结果。
type BackupRunResult struct {
	OK       bool                 `json:"ok"`
	Skipped  string               `json:"skipped,omitempty"`
	Reason   string               `json:"reason,omitempty"`
	Targets  []TargetBackupResult `json:"targets"`
	Accounts int                  `json:"accounts"`
	Skips    []SkippedAccount     `json:"skippedAccounts,omitempty"`
	Error    string               `json:"error,omitempty"`
}

// RunRemoteBackup 导出一次本地账号并按目标隔离推送至所有已启用或指定目标。
func RunRemoteBackup(
	ctx context.Context,
	svc ServiceOptions,
	opts RunOptions,
) (BackupRunResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	aiHomeDir := strings.TrimSpace(svc.AIHomeDir)
	if aiHomeDir == "" {
		return BackupRunResult{}, errors.New("aiHomeDir is required")
	}
	if svc.Exporter == nil {
		return BackupRunResult{}, errors.New("backup account exporter 未配置")
	}

	var config BackupConfig
	if opts.Config != nil {
		config = *opts.Config
	} else {
		loaded, err := ReadBackupConfig(aiHomeDir)
		if err != nil {
			return BackupRunResult{}, err
		}
		config = loaded
	}

	var state BackupState
	if opts.State != nil {
		state = *opts.State
		if state.Targets == nil {
			state.Targets = make(map[string]TargetRunState)
		}
	} else {
		loaded, err := ReadBackupState(aiHomeDir)
		if err != nil {
			return BackupRunResult{}, err
		}
		state = loaded
	}

	targets, err := selectTargets(config, opts.TargetIDs)
	if err != nil {
		return BackupRunResult{}, err
	}
	if len(targets) == 0 {
		return BackupRunResult{
			OK:      true,
			Targets: []TargetBackupResult{},
			Reason:  "no_targets",
		}, nil
	}

	exported, err := svc.Exporter.ExportAccounts(ctx)
	if err != nil {
		return BackupRunResult{}, err
	}

	hostName := strings.TrimSpace(svc.HostName)
	if hostName == "" {
		hostName, _ = os.Hostname()
	}
	nowFn := svc.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	factory := svc.CreateStrategy
	if factory == nil {
		factory = func(target BackupTarget, onHostKey func(string)) (Strategy, error) {
			if strings.ToLower(strings.TrimSpace(target.Strategy)) != DefaultStrategy {
				return nil, fmt.Errorf("不支持的备份策略：%s", target.Strategy)
			}
			return NewSSHBackupStrategy(target, SSHStrategyDeps{
				HomeDir:   svc.HomeDir,
				Env:       svc.Env,
				OnHostKey: onHostKey,
			}), nil
		}
	}

	results := make([]TargetBackupResult, 0, len(targets))
	allOK := true
	for _, target := range targets {
		startedAt := nowFn().UTC().Format(time.RFC3339Nano)
		res := executeSingleTargetBackup(ctx, target, exported.Accounts, opts.Full, hostName, startedAt, factory, svc.Logger, func(fp string) {
			latest, readErr := ReadBackupConfig(aiHomeDir)
			if readErr != nil {
				return
			}
			for idx, item := range latest.Targets {
				if item.ID == target.ID && item.HostKeyFingerprint == "" {
					latest.Targets[idx].HostKeyFingerprint = fp
					if _, writeErr := WriteBackupConfig(aiHomeDir, latest); writeErr == nil && svc.Logger != nil {
						preview := fp
						if len(preview) > 12 {
							preview = preview[:12]
						}
						svc.Logger.Info(fmt.Sprintf("%s: 已记录主机指纹 %s…", target.ID, preview))
					}
					break
				}
			}
		})
		results = append(results, res)
		prevState := state.Targets[target.ID]
		if res.OK {
			state.Targets[target.ID] = TargetRunState{
				LastRunAt: res.StartedAt,
				LastOkAt:  res.StartedAt,
				LastError: "",
				Uploaded:  res.Uploaded,
				Unchanged: res.Unchanged,
				Deleted:   res.Deleted,
				Revision:  res.Revision,
				Total:     res.Total,
			}
		} else {
			allOK = false
			prevState.LastRunAt = res.StartedAt
			prevState.LastError = res.Error
			prevState.Uploaded = 0
			prevState.Unchanged = 0
			prevState.Deleted = 0
			state.Targets[target.ID] = prevState
			if svc.Logger != nil {
				svc.Logger.Warn(fmt.Sprintf("%s: 备份失败（%s）", target.ID, res.Error))
			}
		}
	}

	if _, writeErr := WriteBackupState(aiHomeDir, state); writeErr != nil && svc.Logger != nil {
		svc.Logger.Warn(fmt.Sprintf("备份状态写入失败：%s", safeBackupErrorMessage(writeErr)))
	}

	return BackupRunResult{
		OK:       allOK,
		Targets:  results,
		Accounts: len(exported.Accounts),
		Skips:    exported.Skipped,
	}, nil
}

func executeSingleTargetBackup(
	ctx context.Context,
	target BackupTarget,
	accounts []AccountRecord,
	full bool,
	hostName string,
	startedAt string,
	factory StrategyFactory,
	logger BackupLogger,
	onHostKey func(string),
) TargetBackupResult {
	strategy, err := factory(target, onHostKey)
	if err != nil {
		return TargetBackupResult{
			TargetID:  target.ID,
			OK:        false,
			Error:     safeBackupErrorMessage(err),
			StartedAt: startedAt,
		}
	}
	defer func() {
		_ = strategy.Close()
	}()

	if err := strategy.Connect(ctx); err != nil {
		return TargetBackupResult{
			TargetID:  target.ID,
			OK:        false,
			Error:     safeBackupErrorMessage(err),
			StartedAt: startedAt,
		}
	}

	manifestText, _, err := strategy.ReadFile(ctx, ManifestFileName)
	if err != nil {
		return TargetBackupResult{
			TargetID:  target.ID,
			OK:        false,
			Error:     safeBackupErrorMessage(err),
			StartedAt: startedAt,
		}
	}
	previousManifest, _ := ParseManifest(manifestText)

	plan, err := BuildBackupPlan(accounts, previousManifest, full, hostName)
	if err != nil {
		return TargetBackupResult{
			TargetID:  target.ID,
			OK:        false,
			Error:     safeBackupErrorMessage(err),
			StartedAt: startedAt,
		}
	}

	for _, upload := range plan.Uploads {
		if err := strategy.WriteFile(ctx, upload.Path, upload.Content, 0o600); err != nil {
			return TargetBackupResult{
				TargetID:  target.ID,
				OK:        false,
				Error:     safeBackupErrorMessage(err),
				StartedAt: startedAt,
			}
		}
	}
	// 清单最后写：中途失败时远端仍指向旧清单，不会出现清单里有但账号文件缺损的半截状态。
	if plan.Changed {
		manifestJSON, serErr := SerializeManifest(plan.Manifest)
		if serErr != nil {
			return TargetBackupResult{
				TargetID:  target.ID,
				OK:        false,
				Error:     safeBackupErrorMessage(serErr),
				StartedAt: startedAt,
			}
		}
		if err := strategy.WriteFile(ctx, ManifestFileName, manifestJSON, 0o600); err != nil {
			return TargetBackupResult{
				TargetID:  target.ID,
				OK:        false,
				Error:     safeBackupErrorMessage(err),
				StartedAt: startedAt,
			}
		}
	}

	if logger != nil {
		logger.Info(fmt.Sprintf(
			"%s: 上传 %d，未变 %d，删除标记 %d，revision %d",
			target.ID,
			len(plan.Uploads),
			plan.Unchanged,
			len(plan.Deleted),
			plan.Manifest.Revision,
		))
	}
	return TargetBackupResult{
		TargetID:  target.ID,
		OK:        true,
		Uploaded:  len(plan.Uploads),
		Unchanged: plan.Unchanged,
		Deleted:   len(plan.Deleted),
		Revision:  plan.Manifest.Revision,
		Total:     len(plan.Manifest.Accounts),
		StartedAt: startedAt,
	}
}

func selectTargets(config BackupConfig, targetIDs []string) ([]BackupTarget, error) {
	var ids []string
	for _, raw := range targetIDs {
		if trimmed := strings.TrimSpace(raw); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	if len(ids) == 0 {
		var enabled []BackupTarget
		for _, target := range config.Targets {
			if target.Enabled {
				enabled = append(enabled, target)
			}
		}
		return enabled, nil
	}
	selected := make([]BackupTarget, 0, len(ids))
	var unknown []string
	for _, id := range ids {
		var match *BackupTarget
		for idx := range config.Targets {
			item := &config.Targets[idx]
			if item.ID == id || item.Username+"@"+item.Host == id {
				match = item
				break
			}
		}
		if match == nil {
			unknown = append(unknown, id)
			continue
		}
		selected = append(selected, *match)
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("找不到备份目标：%s", strings.Join(unknown, ", "))
	}
	return selected, nil
}

func safeBackupErrorMessage(err error) string {
	if err == nil {
		return "backup_failed"
	}
	text := strings.TrimSpace(err.Error())
	if text == "" {
		text = "backup_failed"
	}
	if len(text) > 300 {
		return text[:300]
	}
	return text
}
