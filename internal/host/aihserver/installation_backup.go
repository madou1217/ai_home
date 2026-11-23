package aihserver

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/installationbackup"
	"github.com/madou1217/ai_home/internal/transport/http/webuiinstallationbackupapi"
)

// buildInstallationBackupRoutes 提供运行文件（程序 + Web UI）的可视化备份与恢复。
//
// 恢复只写回文件；重启复用 /server/restart 契约，避免在备份切片里再造一套服务管理。
func buildInstallationBackupRoutes(deps webuiRouteDependencies) ([]webuiRoute, error) {
	if deps.AIHomeDir == "" || deps.Authorizer == nil {
		return nil, nil
	}
	serverPath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("运行文件备份无法定位服务器程序: %w", err)
	}
	if resolved, resolveErr := filepath.EvalSymlinks(serverPath); resolveErr == nil {
		serverPath = resolved
	}
	cliPath := ""
	for _, candidate := range []string{
		filepath.Join(filepath.Dir(serverPath), "aih-go"),
		filepath.Join(deps.AIHomeDir, "bin", "aih-go"),
	} {
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			cliPath = candidate
			break
		}
	}
	manager, err := installationbackup.New(installationbackup.Options{
		AIHomeDir:    deps.AIHomeDir,
		ServerBinary: serverPath,
		CLIBinary:    cliPath,
		WebDir:       deps.WebDir,
	})
	if err != nil {
		return nil, err
	}
	handler, err := webuiinstallationbackupapi.NewHandler(webuiinstallationbackupapi.Dependencies{
		Authorizer: deps.Authorizer,
		Manager:    manager,
	})
	if err != nil {
		return nil, err
	}
	path := webuiinstallationbackupapi.Path
	return []webuiRoute{
		{Pattern: "GET " + path, Handler: handler},
		{Pattern: "POST " + path, Handler: handler},
		{Pattern: "POST " + path + "/{id}/restore", Handler: handler},
		{Pattern: "DELETE " + path + "/{id}", Handler: handler},
	}, nil
}
