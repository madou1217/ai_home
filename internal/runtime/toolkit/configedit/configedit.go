package configedit

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// MaxConfigBytes 限制可在线编辑的单配置文件大小为 2MB。
const MaxConfigBytes = 2 * 1024 * 1024

var toolTargetTokenKey = mustGenerateRandomKey()

func mustGenerateRandomKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return []byte(fmt.Sprintf("fallback-%d", time.Now().UnixNano()))
	}
	return key
}

// ToolkitError 是带语义错误码的 Toolkit 配置异常，直接映射 HTTP 状态码。
type ToolkitError struct {
	Code    string
	Message string
	Detail  string
}

func (err *ToolkitError) Error() string {
	return err.Message
}

// NewError 构造 ToolkitError。
func NewError(code string, message string) *ToolkitError {
	return &ToolkitError{Code: code, Message: message}
}

// HTTPStatus 返回 ToolkitError 对应的 HTTP 状态码。
func HTTPStatus(err error) int {
	var tkErr *ToolkitError
	if !errors.As(err, &tkErr) {
		return 500
	}
	switch tkErr.Code {
	case "config_not_found":
		return 404
	case "config_conflict", "config_target_changed", "config_target_ambiguous", "config_target_unresolved":
		return 409
	case "config_too_large":
		return 413
	case "config_validation_failed":
		return 422
	case "unsupported_app", "unsupported_tool", "tool_config_unsupported", "config_target_unavailable", "content_required":
		return 400
	case "privilege_unavailable", "privilege_denied":
		return 403
	case "config_read_failed", "config_save_failed":
		return 500
	default:
		return 500
	}
}

// ReadResult 是读取应用/工具配置文件的返回体。
type ReadResult struct {
	OK                bool   `json:"ok"`
	AppID             string `json:"appId"`
	ToolID            string `json:"toolId,omitempty"`
	ConfigName        string `json:"configName"`
	ConfigFormat      string `json:"configFormat"`
	Exists            bool   `json:"exists"`
	Content           string `json:"content"`
	Revision          string `json:"revision"`
	TargetRevision    string `json:"targetRevision,omitempty"`
	Writable          bool   `json:"writable"`
	RequiresElevation bool   `json:"requiresElevation"`
	Elevated          bool   `json:"elevated"`
}

// SaveResult 是保存应用/工具配置文件的返回体。
type SaveResult struct {
	OK                bool   `json:"ok"`
	AppID             string `json:"appId"`
	ToolID            string `json:"toolId,omitempty"`
	ConfigName        string `json:"configName"`
	ConfigFormat      string `json:"configFormat"`
	Exists            bool   `json:"exists"`
	Revision          string `json:"revision"`
	TargetRevision    string `json:"targetRevision,omitempty"`
	Size              int    `json:"size"`
	Elevated          bool   `json:"elevated"`
	RequiresElevation bool   `json:"requiresElevation"`
}

// Options 控制读取或保存配置文件时的行为与注入依赖。
type Options struct {
	Catalog          *providers.Catalog
	HostHomeDir      string
	GOOS             string
	Env              map[string]string
	LookupEnv        func(string) string
	TargetPath       string
	ConfigFormat     string
	AllowCreate      bool
	DefaultContent   string
	ExpectedRevision string
	Exec             environment.Executor
	Elevation        ElevationRunner
}

// HashContent 返回配置文本的 SHA-256 十六进制摘要（revision）。
func HashContent(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// ComputeTargetRevision 对隐藏后的真实目标路径签发进程内 HMAC 校验令牌。
func ComputeTargetRevision(targetPath string, goos string) string {
	identity := canonicalizeWithAncestorSymlinks(strings.TrimSpace(targetPath))
	identity = filepath.Clean(identity)
	if NormalizePlatform(goos) == "windows" {
		identity = strings.ToLower(identity)
	}
	mac := hmac.New(sha256.New, toolTargetTokenKey)
	_, _ = mac.Write([]byte(identity))
	return hex.EncodeToString(mac.Sum(nil))
}

func canonicalizeWithAncestorSymlinks(targetPath string) string {
	if targetPath == "" {
		return ""
	}
	cur := targetPath
	var tail []string
	for cur != "" {
		if resolved, err := filepath.EvalSymlinks(cur); err == nil {
			parts := append([]string{resolved}, tail...)
			return filepath.Join(parts...)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		tail = append([]string{filepath.Base(cur)}, tail...)
		cur = parent
	}
	return targetPath
}

// ReadAppConfig 读取受管应用配置。
func ReadAppConfig(ctx context.Context, appID string, options Options) (ReadResult, error) {
	displayTarget, err := resolveTargetFromOptions(appID, options)
	if err != nil {
		return ReadResult{}, err
	}
	return ReadTarget(ctx, displayTarget, options)
}

// SaveAppConfig 原子保存受管应用配置。
func SaveAppConfig(ctx context.Context, appID string, content string, options Options) (SaveResult, error) {
	displayTarget, err := resolveTargetFromOptions(appID, options)
	if err != nil {
		return SaveResult{}, err
	}
	return SaveTarget(ctx, displayTarget, content, options)
}

// ReadTarget 从已解析目标读取配置（供 tools 模块直接复用）。
func ReadTarget(ctx context.Context, displayTarget Target, options Options) (ReadResult, error) {
	resolvedPath := canonicalExistingPath(displayTarget.TargetPath)
	exists := fileExistsAny(resolvedPath)
	writable := isWritableTarget(resolvedPath)

	if !exists {
		if options.AllowCreate {
			return ReadResult{
				OK:                true,
				AppID:             displayTarget.AppID,
				ConfigName:        displayTarget.ConfigName,
				ConfigFormat:      displayTarget.ConfigFormat,
				Exists:            false,
				Content:           options.DefaultContent,
				Revision:          "missing",
				Writable:          writable,
				RequiresElevation: !writable,
			}, nil
		}
		return ReadResult{}, configNotFoundError()
	}

	elevated := false
	rawBytes, err := os.ReadFile(resolvedPath)
	var content string
	if err != nil {
		if isElevationError(err) {
			elevRunner := options.Elevation
			if elevRunner == nil {
				elevRunner = defaultElevationRunner(options.Exec)
			}
			elevContent, elevErr := readElevatedFile(ctx, elevRunner, displayTarget.Platform, resolvedPath, options.Env)
			if elevErr != nil {
				return ReadResult{}, elevErr
			}
			content = elevContent
			elevated = true
		} else {
			return ReadResult{}, configIOError("read", err)
		}
	} else {
		content = string(rawBytes)
	}

	if len([]byte(content)) > MaxConfigBytes {
		return ReadResult{}, NewError("config_too_large", "配置文件超过 2MB 编辑上限")
	}

	return ReadResult{
		OK:                true,
		AppID:             displayTarget.AppID,
		ConfigName:        displayTarget.ConfigName,
		ConfigFormat:      displayTarget.ConfigFormat,
		Exists:            true,
		Content:           content,
		Revision:          HashContent(content),
		Writable:          writable,
		RequiresElevation: !writable,
		Elevated:          elevated,
	}, nil
}

// SaveTarget 对已解析目标执行乐观锁检查和原子保存。
func SaveTarget(ctx context.Context, displayTarget Target, content string, options Options) (SaveResult, error) {
	resolvedPath := canonicalExistingPath(displayTarget.TargetPath)
	exists := fileExistsAny(resolvedPath)
	create := options.AllowCreate && strings.TrimSpace(options.ExpectedRevision) == "missing"

	if create && exists {
		return SaveResult{}, NewError("config_conflict", "配置文件已由其他进程创建，请重新读取后再保存")
	}
	if !exists && !create {
		return SaveResult{}, configNotFoundError()
	}
	if len([]byte(content)) > MaxConfigBytes {
		return SaveResult{}, NewError("config_too_large", "配置文件超过 2MB 编辑上限")
	}

	expectedRevision := strings.TrimSpace(options.ExpectedRevision)
	if expectedRevision != "" && !create {
		current, err := ReadTarget(ctx, displayTarget, options)
		if err != nil {
			return SaveResult{}, err
		}
		if current.Revision != expectedRevision {
			return SaveResult{}, NewError("config_conflict", "配置文件在编辑期间已被其他进程修改，请重新读取后再保存")
		}
	}

	elevated := false
	mode := resolveFileMode(resolvedPath)
	if err := writeAtomicFile(resolvedPath, content, mode, create); err != nil {
		var tkErr *ToolkitError
		if errors.As(err, &tkErr) {
			return SaveResult{}, err
		}
		if errors.Is(err, os.ErrExist) {
			return SaveResult{}, NewError("config_conflict", "配置文件已由其他进程创建，请重新读取后再保存")
		}
		if !isElevationError(err) || create {
			return SaveResult{}, configIOError("save", err)
		}
		elevRunner := options.Elevation
		if elevRunner == nil {
			elevRunner = defaultElevationRunner(options.Exec)
		}
		if elevErr := writeElevatedFile(ctx, elevRunner, displayTarget.Platform, resolvedPath, content, mode, options.Env); elevErr != nil {
			return SaveResult{}, elevErr
		}
		elevated = true
	}

	return SaveResult{
		OK:                true,
		AppID:             displayTarget.AppID,
		ConfigName:        displayTarget.ConfigName,
		ConfigFormat:      displayTarget.ConfigFormat,
		Exists:            true,
		Revision:          HashContent(content),
		Size:              len([]byte(content)),
		Elevated:          elevated,
		RequiresElevation: elevated,
	}, nil
}

func resolveTargetFromOptions(appID string, options Options) (Target, error) {
	goos := options.GOOS
	if strings.TrimSpace(goos) == "" {
		goos = runtime.GOOS
	}
	lookupEnv := options.LookupEnv
	if lookupEnv == nil {
		if len(options.Env) > 0 {
			lookupEnv = func(k string) string { return options.Env[k] }
		} else {
			lookupEnv = os.Getenv
		}
	}
	if strings.TrimSpace(options.TargetPath) != "" {
		normalized := strings.ToLower(strings.TrimSpace(appID))
		format := strings.TrimSpace(options.ConfigFormat)
		if format == "" {
			format = ConfigFormat(options.TargetPath)
		}
		return Target{
			AppID:        normalized,
			Provider:     normalized,
			Platform:     NormalizePlatform(goos),
			HostHomeDir:  options.HostHomeDir,
			TargetPath:   options.TargetPath,
			ConfigName:   filepath.Base(options.TargetPath),
			ConfigFormat: format,
		}, nil
	}
	return ResolveAppTarget(options.Catalog, appID, options.HostHomeDir, goos, lookupEnv)
}

func canonicalExistingPath(path string) string {
	if path == "" || !fileExistsAny(path) {
		return path
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	return path
}

func fileExistsAny(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func resolveFileMode(path string) os.FileMode {
	if info, err := os.Stat(path); err == nil {
		if perm := info.Mode().Perm(); perm != 0 {
			return perm
		}
	}
	return 0o600
}

func writeAtomicFile(targetPath string, content string, mode os.FileMode, create bool) error {
	parent := filepath.Dir(targetPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	tempPath := createSiblingTempPath(targetPath)
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tempPath)
		}
	}()
	if _, err := file.WriteString(content); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tempPath, mode)

	if create {
		if err := os.Link(tempPath, targetPath); err != nil {
			return err
		}
		_ = os.Remove(tempPath)
		renamed = true
		return nil
	}
	if !fileExistsAny(targetPath) {
		return configNotFoundError()
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}
	renamed = true
	return nil
}

func createSiblingTempPath(targetPath string) string {
	return fmt.Sprintf("%s.aih-edit-%d-%s", targetPath, os.Getpid(), randomHex(8))
}

func isElevationError(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, fs.ErrPermission) ||
		errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.EPERM) ||
		errors.Is(err, syscall.EROFS)
}

func configIOError(operation string, err error) error {
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOENT) {
		return NewError("config_target_changed", "配置目标在操作期间发生变化，请重新读取后再试")
	}
	if operation == "read" {
		return NewError("config_read_failed", "读取配置失败")
	}
	return NewError("config_save_failed", "保存配置失败")
}

func configNotFoundError() error {
	return NewError("config_not_found", "配置文件不存在，只能编辑已存在的配置")
}

func firstNonEmpty(values ...string) string {
	for _, item := range values {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// CanWriteTarget 探测目标配置文件（或最近已存在父目录）当前进程是否可直接写入。
func CanWriteTarget(targetPath string) bool {
	return isWritableTarget(targetPath)
}
