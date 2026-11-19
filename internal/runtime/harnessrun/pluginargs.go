package harnessrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// 外部宿主（pi / deepseek）的插件承载能力。
//
// 唯一事实来源是 internal/runtime/nativeresources 的 hostResourceCapabilities，
// 但该表未导出；`aih harness` 只依赖 pi / dsh 两条记录，因此在这里保留最小副本
// （launchArgument / launchFromInstall / adapter）。后续把该能力导出后应删除本表。
type hostPluginCapability struct {
	LaunchArgument    string
	LaunchFromInstall bool
	Adapter           string
}

var hostPluginCapabilities = map[string]hostPluginCapability{
	"pi":       {LaunchArgument: "--extension", Adapter: "native-directory"},
	"deepseek": {LaunchArgument: "--patch", LaunchFromInstall: true, Adapter: "cordis-patch"},
}

const managedStateKVKey = "native-resources.managed.v1"

var (
	errHostPluginProjectionModified = errors.New("native_plugin_runtime_projection_modified")
	errHostPluginProjectionInvalid  = errors.New("native_plugin_runtime_projection_invalid")
)

type managedResource struct {
	Kind          string         `json:"kind"`
	ID            string         `json:"id"`
	Host          string         `json:"host"`
	Enabled       bool           `json:"enabled"`
	Target        string         `json:"target"`
	Digest        string         `json:"digest"`
	NativeInstall map[string]any `json:"nativeInstall"`
}

type managedState struct {
	Resources []managedResource `json:"resources"`
}

// buildHostPluginArgs 复刻 lib/native-resources/host-plugin-runtime.js 的
// buildManagedHostPluginArgs：健康检查（doctor）通过后，为每条启用的插件记录
// 生成 [launchArgument, target]。
func buildHostPluginArgs(
	ctx context.Context,
	aiHomeDir string,
	hostHomeDir string,
	host string,
) ([]string, error) {
	capability, ok := hostPluginCapabilities[strings.ToLower(strings.TrimSpace(host))]
	if !ok || capability.LaunchArgument == "" {
		return nil, nil
	}
	if strings.TrimSpace(aiHomeDir) == "" || strings.TrimSpace(hostHomeDir) == "" {
		return nil, nil
	}
	resources := readManagedResources(ctx, aiHomeDir)
	args := make([]string, 0)
	for _, resource := range resources {
		if resource.Kind != "native-plugin" || !strings.EqualFold(strings.TrimSpace(resource.Host), host) {
			continue
		}
		status := inspectManagedResource(capability.Adapter, resource)
		healthy := status == "present"
		if !resource.Enabled {
			healthy = status == "absent"
		}
		if !healthy {
			return nil, errHostPluginProjectionModified
		}
	}
	for _, resource := range resources {
		if resource.Kind != "native-plugin" || !strings.EqualFold(strings.TrimSpace(resource.Host), host) || !resource.Enabled {
			continue
		}
		target := resource.Target
		if capability.LaunchFromInstall {
			// Node 用 record.nativeInstall?.launchPath；缺失就是无效投影，
			// 不能回退到插件目录（那会把目录当 patch 文件传给 --patch）。
			target, _ = resource.NativeInstall["launchPath"].(string)
		}
		if !filepath.IsAbs(strings.TrimSpace(target)) {
			return nil, errHostPluginProjectionInvalid
		}
		args = append(args, capability.LaunchArgument, target)
	}
	return args, nil
}

func readManagedResources(ctx context.Context, aiHomeDir string) []managedResource {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, managedStateKVKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil
	}
	var state managedState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return nil
	}
	return state.Resources
}

// inspectManagedResource 对应 Node adapter.inspect。
func inspectManagedResource(adapter string, resource managedResource) string {
	switch adapter {
	case "native-directory":
		return directoryStatus(resource)
	case "cordis-patch":
		projected := directoryStatus(resource)
		patch := cordisPatchStatus(resource)
		if projected == patch {
			return projected
		}
		return "modified"
	default:
		// 未知适配器不宣称健康，避免把未验证的投影当作可启动插件。
		return "modified"
	}
}

func directoryStatus(resource managedResource) string {
	info, err := os.Lstat(strings.TrimSpace(resource.Target))
	if err != nil {
		if os.IsNotExist(err) {
			return "absent"
		}
		return "modified"
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "modified"
	}
	digest, err := digestDirectory(resource.Target)
	if err != nil {
		return "modified"
	}
	if digest == strings.TrimSpace(resource.Digest) {
		return "present"
	}
	return "modified"
}

func cordisPatchStatus(resource managedResource) string {
	launchPath, _ := resource.NativeInstall["launchPath"].(string)
	patchDigest, _ := resource.NativeInstall["patchDigest"].(string)
	if strings.TrimSpace(launchPath) == "" {
		return "absent"
	}
	info, err := os.Lstat(launchPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "absent"
		}
		return "modified"
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 64*1024 {
		return "modified"
	}
	content, err := os.ReadFile(launchPath)
	if err != nil {
		return "modified"
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) == strings.TrimSpace(patchDigest) {
		return "present"
	}
	return "modified"
}

type managedFile struct {
	Name       string
	Content    []byte
	Executable bool
}

const (
	managedFilesByteLimit = 4 * 1024 * 1024
	managedFilesCountMax  = 256
)

// digestDirectory 复刻 Node digestFiles(readSkillFiles(root))：
// 目录逐级按名称排序，拒绝符号链接，按 [name, length, executable] + content 计算 SHA-256。
func digestDirectory(root string) (string, error) {
	files := make([]managedFile, 0)
	totalBytes := 0
	var walk func(directory string, relative string) error
	walk = func(directory string, relative string) error {
		info, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink")
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
		for _, entry := range entries {
			childPath := filepath.Join(directory, entry.Name())
			childRelative := entry.Name()
			if relative != "" {
				childRelative = relative + "/" + entry.Name()
			}
			childInfo, err := os.Lstat(childPath)
			if err != nil {
				return err
			}
			if childInfo.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlink")
			}
			if childInfo.IsDir() {
				if err := walk(childPath, childRelative); err != nil {
					return err
				}
				continue
			}
			if !childInfo.Mode().IsRegular() {
				return fmt.Errorf("type")
			}
			content, err := os.ReadFile(childPath)
			if err != nil {
				return err
			}
			totalBytes += len(content)
			if totalBytes > managedFilesByteLimit || len(files) >= managedFilesCountMax {
				return fmt.Errorf("limit")
			}
			files = append(files, managedFile{
				Name:       childRelative,
				Content:    content,
				Executable: childInfo.Mode()&0o111 != 0,
			})
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return "", err
	}
	hash := sha256.New()
	for _, file := range files {
		header, err := json.Marshal([]any{file.Name, len(file.Content), file.Executable})
		if err != nil {
			return "", err
		}
		hash.Write(header)
		hash.Write(file.Content)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
