package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// globalSessionStore 构造读取持久会话的存储（注册表 + tmux 实时探测）。
func globalSessionStore(runtime commandRuntime) (*persistent.TmuxSessionStore, error) {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, err
	}
	registry, err := persistent.NewRegistry(filepath.Join(aiHomeDir, "run"))
	if err != nil {
		return nil, err
	}
	return &persistent.TmuxSessionStore{
		AIHomeDir: aiHomeDir,
		Registry:  registry,
		Catalog:   catalog,
		Platform:  goruntime.GOOS,
		Env:       os.Getenv,
	}, nil
}

// collectGlobalLabels 为行涉及到的 Provider 批量取账号显示名。
func collectGlobalLabels(
	ctx context.Context,
	rows []persistent.SessionRow,
	runtime commandRuntime,
) map[string]string {
	labels := make(map[string]string)
	seen := make(map[string]bool)
	for _, row := range rows {
		if seen[row.Provider] {
			continue
		}
		seen[row.Provider] = true
		for ref, label := range sessionAccountLabels(ctx, row.Provider, runtime) {
			labels[ref] = label
		}
	}
	return labels
}

// pickerStore 把 TmuxSessionStore 适配成选择器的读写端口。
type pickerStore struct {
	store *persistent.TmuxSessionStore
}

func (source pickerStore) Rows(ctx context.Context) ([]persistent.SessionRow, error) {
	rows, err := source.store.CollectSessions(ctx)
	if err != nil {
		return nil, err
	}
	// 选择器重载（关闭会话后）也补一次缓存标题，避免掉回 pane 名。
	persistent.ApplySessionCache(rows, persistent.ReadSessionCache(source.store.AIHomeDir, time.Now()))
	return rows, nil
}

func (source pickerStore) Close(ctx context.Context, row persistent.SessionRow) error {
	return source.store.CloseSession(ctx, row)
}

// runGlobalSessionPicker 实现 aih ss 的默认形态：TTY 下进入交互选择器，
// 非 TTY（管道/CI）直接打印按项目分组的列表，与 Node 行为一致。
func runGlobalSessionPicker(ctx context.Context, runtime commandRuntime, refresh bool) error {
	store, err := globalSessionStore(runtime)
	if err != nil {
		return err
	}
	var rows []persistent.SessionRow
	if refresh {
		// --refresh：忽略缓存，直接用原生会话库解析标题/原生 id，再回写缓存。
		rows, err = store.CollectSessions(ctx)
		if err != nil {
			return fmt.Errorf("读取持久会话失败: %w", err)
		}
		resolveSessionTitles(ctx, runtime, rows)
		_ = persistent.WriteSessionCache(store.AIHomeDir, rows, time.Now())
	} else {
		// 默认走与 --list 相同的采集+缓存补全，picker 里的 c/y 才有原生会话 id。
		rows, err = collectGlobalRows(ctx, runtime)
		if err != nil {
			return err
		}
	}
	labels := collectGlobalLabels(ctx, rows, runtime)
	if !terminalWriterIsTTY(runtime.stdin) || !terminalWriterIsTTY(runtime.stdout) {
		writeGlobalSessionGroups(runtime.stdout, rows, labels)
		return nil
	}
	return runSessionPicker(ctx, runtime, pickerStore{store: store}, labels)
}
