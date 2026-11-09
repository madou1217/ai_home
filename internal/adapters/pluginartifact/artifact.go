package pluginartifact

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// Magic 是 .aih-plugin 的 8 字节魔数，与 Node artifact.js 的 MAGIC 逐字一致。
const Magic = "AIHPLG01"

const (
	headerBytes                = len(Magic) + 4
	copyChunkBytes             = 1024 * 1024
	codePackageMissing         = "plugin_package_missing"
	codePackageBytesLimit      = "plugin_package_bytes_limit"
	codePackageMagicInvalid    = "plugin_package_magic_invalid"
	codePackageMetadataLimit   = "plugin_package_metadata_limit"
	codePackageTruncated       = "plugin_package_truncated"
	codePackageMetadataInvalid = "plugin_package_metadata_invalid"
	codePackageFileCount       = "plugin_package_file_count"
	codePackagePathInvalid     = "plugin_package_path_invalid"
	codePackagePathCollision   = "plugin_package_path_collision"
	codePackageFileInvalid     = "plugin_package_file_invalid"
	codePackageDigestInvalid   = "plugin_package_digest_invalid"
	codePackageDigestMismatch  = "plugin_package_digest_mismatch"
	codePackageTrailingBytes   = "plugin_package_trailing_bytes"
	codeEntryMissing           = "plugin_entry_missing"
)

var (
	windowsReservedPattern = regexp.MustCompile("(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\\..*)?$")
	sha256Pattern          = regexp.MustCompile("^[a-f0-9]{64}$")
)

// Acceptor 负责把上传的 .aih-plugin 校验、落盘并解压到插件数据根。
type Acceptor struct {
	aiHomeDir string
}

// NewAcceptor 创建制品接受器；空数据根拒绝创建，避免把插件写到进程工作目录。
func NewAcceptor(aiHomeDir string) (*Acceptor, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("插件制品存储缺少 aiHomeDir")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Acceptor{aiHomeDir: absolute}, nil
}

type fileRecord struct {
	Path   string
	Size   int64
	SHA256 string
	Offset int64
}

type inspectedArtifact struct {
	file      string
	manifest  map[string]any
	metadata  map[string]any
	files     []fileRecord
	signature Signature
}

// Accept 复刻 Node acceptArtifact：
//  1. 复制到 accepted/ 的临时名，同时流式计算整体摘要；
//  2. 校验包结构与每个文件的摘要；
//  3. 原子 rename 成 accepted/<digest>.aih-plugin；
//  4. 从私有副本解压到 extracted/ 临时目录，逐文件再校验后原子 rename。
//
// 任何一步失败都删除临时产物，坏包不会在磁盘上留下任何东西。
func (acceptor *Acceptor) Accept(file string, options AcceptOptions) (Accepted, error) {
	acceptedDir := filepath.Join(acceptor.aiHomeDir, "plugins", "accepted")
	extractedDir := filepath.Join(acceptor.aiHomeDir, "plugins", "extracted")
	if err := os.MkdirAll(acceptedDir, 0o700); err != nil {
		return Accepted{}, pluginerr.New("plugin_state_unavailable", fmt.Sprintf("插件目录不可写：%s", acceptedDir))
	}
	if err := os.MkdirAll(extractedDir, 0o700); err != nil {
		return Accepted{}, pluginerr.New("plugin_state_unavailable", fmt.Sprintf("插件目录不可写：%s", extractedDir))
	}
	source, err := filepath.Abs(strings.TrimSpace(file))
	if err != nil {
		source = strings.TrimSpace(file)
	}
	stat, err := os.Stat(source)
	if err != nil || !stat.Mode().IsRegular() {
		return Accepted{}, pluginerr.New(codePackageMissing, fmt.Sprintf("找不到插件包：%s", source))
	}
	nonce, err := randomHex(8)
	if err != nil {
		return Accepted{}, pluginerr.New(codePackageMissing, "无法生成临时文件名")
	}
	staging := filepath.Join(acceptedDir, ".incoming-"+nonce)
	stagingDir := filepath.Join(extractedDir, ".incoming-"+nonce)
	defer func() {
		_ = os.Remove(staging)
		_ = os.RemoveAll(stagingDir)
	}()
	digest, err := copyWithDigest(source, staging)
	if err != nil {
		return Accepted{}, err
	}
	inspected, err := inspectArtifact(staging, acceptor.aiHomeDir, options)
	if err != nil {
		return Accepted{}, err
	}
	artifactPath := filepath.Join(acceptedDir, digest+".aih-plugin")
	directory := filepath.Join(extractedDir, digest)
	if exists(artifactPath) {
		_ = os.Remove(staging)
	} else if err := os.Rename(staging, artifactPath); err != nil {
		return Accepted{}, pluginerr.New(codePackageMissing, fmt.Sprintf("无法保存插件包：%s", artifactPath))
	}
	if !exists(directory) {
		inspected.file = artifactPath
		if err := extractVerified(inspected, stagingDir); err != nil {
			return Accepted{}, err
		}
		if err := os.Rename(stagingDir, directory); err != nil {
			return Accepted{}, pluginerr.New("plugin_state_unavailable", fmt.Sprintf("无法解压插件：%s", directory))
		}
	}
	manifestJSON, err := encodeJSONNoEscape(inspected.manifest)
	if err != nil {
		return Accepted{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	return Accepted{
		Digest:                 digest,
		ArtifactPath:           artifactPath,
		Directory:              directory,
		Manifest:               json.RawMessage(manifestJSON),
		ManifestValue:          inspected.manifest,
		Signature:              inspected.signature,
		Files:                  len(inspected.files),
		PermissionsFingerprint: PermissionFingerprint(inspected.manifest),
	}, nil
}

// Inspect 只校验包结构与摘要（不解压），供测试和诊断使用。
func Inspect(file string, aiHomeDir string, options AcceptOptions) (Accepted, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(file))
	if err != nil {
		absolute = strings.TrimSpace(file)
	}
	inspected, err := inspectArtifact(absolute, aiHomeDir, options)
	if err != nil {
		return Accepted{}, err
	}
	manifestJSON, err := encodeJSONNoEscape(inspected.manifest)
	if err != nil {
		return Accepted{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	return Accepted{
		Manifest:               json.RawMessage(manifestJSON),
		ManifestValue:          inspected.manifest,
		Signature:              inspected.signature,
		Files:                  len(inspected.files),
		PermissionsFingerprint: PermissionFingerprint(inspected.manifest),
	}, nil
}

func inspectArtifact(file string, aiHomeDir string, options AcceptOptions) (inspectedArtifact, error) {
	handle, err := os.Open(file)
	if err != nil {
		return inspectedArtifact{}, pluginerr.New(codePackageMissing, fmt.Sprintf("找不到插件包：%s", file))
	}
	defer func() { _ = handle.Close() }()
	stat, err := handle.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > plugincontract.MaxPackageBytes {
		return inspectedArtifact{}, pluginerr.New(codePackageBytesLimit, "")
	}
	header := make([]byte, headerBytes)
	if _, err := io.ReadFull(handle, header); err != nil || string(header[:len(Magic)]) != Magic {
		return inspectedArtifact{}, pluginerr.New(codePackageMagicInvalid, "不是 AIH 插件包")
	}
	metadataBytes := binary.BigEndian.Uint32(header[len(Magic):])
	if metadataBytes == 0 || int64(metadataBytes) > plugincontract.MaxPackageMetadataBytes {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataLimit, "")
	}
	metadataBuffer := make([]byte, metadataBytes)
	if _, err := io.ReadFull(handle, metadataBuffer); err != nil {
		return inspectedArtifact{}, pluginerr.New(codePackageTruncated, "")
	}
	decoder := json.NewDecoder(strings.NewReader(string(metadataBuffer)))
	decoder.UseNumber()
	var metadata any
	if err := decoder.Decode(&metadata); err != nil {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	metadataObject, ok := metadata.(map[string]any)
	if !ok {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	formatVersion, hasVersion := numberValue(metadataObject["formatVersion"])
	if !hasVersion || formatVersion != 1 {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	recordsValue, isArray := metadataObject["files"].([]any)
	if !isArray {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	if len(recordsValue) > plugincontract.MaxPackageFiles {
		return inspectedArtifact{}, pluginerr.New(codePackageFileCount, "")
	}
	manifestValue, ok := metadataObject["manifest"].(map[string]any)
	if !ok {
		return inspectedArtifact{}, pluginerr.New(codePackageMetadataInvalid, "")
	}
	normalizedManifest, err := ValidateManifest(manifestValue, ManifestOptions{
		HostVersion: options.HostVersion,
		NodeVersion: options.NodeVersion,
		Target:      options.Target,
	})
	if err != nil {
		return inspectedArtifact{}, err
	}
	signature, signatureErr := resolveSignature(metadataObject, signatureOptions{
		AIHomeDir:     aiHomeDir,
		TrustedKeys:   options.TrustedKeys,
		RequireSigned: options.RequireSigned,
	})
	if signatureErr != nil {
		return inspectedArtifact{}, signatureErr
	}
	_ = signature
	seenPaths := map[string]bool{}
	for _, recordValue := range recordsValue {
		record, _ := recordValue.(map[string]any)
		path, _ := record["path"].(string)
		folded := strings.ToLower(path)
		if seenPaths[folded] {
			return inspectedArtifact{}, pluginerr.New(codePackagePathCollision,
				fmt.Sprintf("大小写不敏感的文件系统上会互相覆盖：%s", path))
		}
		seenPaths[folded] = true
	}
	offset := int64(headerBytes) + int64(metadataBytes)
	records := make([]fileRecord, 0, len(recordsValue))
	for _, recordValue := range recordsValue {
		record, _ := recordValue.(map[string]any)
		path, _ := record["path"].(string)
		if !safePackagePath(path) {
			return inspectedArtifact{}, pluginerr.New(codePackagePathInvalid, fmt.Sprintf("非法路径：%s", path))
		}
		size, hasSize := safeNonNegativeInteger(record["size"])
		if !hasSize {
			return inspectedArtifact{}, pluginerr.New(codePackageFileInvalid, "")
		}
		expectedDigest, _ := record["sha256"].(string)
		if !sha256Pattern.MatchString(expectedDigest) {
			return inspectedArtifact{}, pluginerr.New(codePackageDigestInvalid, "")
		}
		end := offset + size
		if end < offset || end > stat.Size() {
			return inspectedArtifact{}, pluginerr.New(codePackageTruncated, "")
		}
		digest, err := sha256Range(handle, offset, size)
		if err != nil {
			return inspectedArtifact{}, pluginerr.New(codePackageTruncated, "")
		}
		if digest != expectedDigest {
			return inspectedArtifact{}, pluginerr.New(codePackageDigestMismatch, fmt.Sprintf("文件被篡改：%s", path))
		}
		records = append(records, fileRecord{Path: path, Size: size, SHA256: expectedDigest, Offset: offset})
		offset = end
	}
	if offset != stat.Size() {
		return inspectedArtifact{}, pluginerr.New(codePackageTrailingBytes, "")
	}
	entry, _ := normalizedManifest["entry"].(string)
	entryFound := false
	for _, record := range records {
		if record.Path == entry {
			entryFound = true
			break
		}
	}
	if !entryFound {
		return inspectedArtifact{}, pluginerr.New(codeEntryMissing, "")
	}
	return inspectedArtifact{
		file:      file,
		manifest:  normalizedManifest,
		metadata:  metadataObject,
		files:     records,
		signature: signature,
	}, nil
}

func extractVerified(inspected inspectedArtifact, destination string) error {
	handle, err := os.Open(inspected.file)
	if err != nil {
		return pluginerr.New(codePackageMissing, fmt.Sprintf("找不到插件包：%s", inspected.file))
	}
	defer func() { _ = handle.Close() }()
	for _, record := range inspected.files {
		target := filepath.Join(destination, filepath.FromSlash(record.Path))
		relative, err := filepath.Rel(destination, target)
		if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return pluginerr.New(codePackagePathInvalid, fmt.Sprintf("非法路径：%s", record.Path))
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return pluginerr.New("plugin_state_unavailable", fmt.Sprintf("无法创建插件目录：%s", filepath.Dir(target)))
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return pluginerr.New("plugin_state_unavailable", fmt.Sprintf("无法写入插件文件：%s", target))
		}
		hash := sha256.New()
		written, copyErr := io.Copy(io.MultiWriter(output, hash), io.NewSectionReader(handle, record.Offset, record.Size))
		if copyErr == nil && written != record.Size {
			copyErr = io.ErrUnexpectedEOF
		}
		closeErr := output.Close()
		if copyErr != nil || closeErr != nil {
			return pluginerr.New(codePackageTruncated, "")
		}
		if hex.EncodeToString(hash.Sum(nil)) != record.SHA256 {
			return pluginerr.New(codePackageDigestMismatch, fmt.Sprintf("解压时校验失败：%s", record.Path))
		}
	}
	return nil
}

func copyWithDigest(source string, target string) (string, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", pluginerr.New(codePackageMissing, fmt.Sprintf("找不到插件包：%s", source))
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", pluginerr.New(codePackageMissing, fmt.Sprintf("无法写入插件副本：%s", target))
	}
	hash := sha256.New()
	buffer := make([]byte, copyChunkBytes)
	var total int64
	copyErr := error(nil)
	for {
		count, readErr := input.Read(buffer)
		if count > 0 {
			total += int64(count)
			if total > plugincontract.MaxPackageBytes {
				copyErr = pluginerr.New(codePackageBytesLimit, "")
				break
			}
			if _, err := hash.Write(buffer[:count]); err != nil {
				copyErr = err
				break
			}
			if _, err := output.Write(buffer[:count]); err != nil {
				copyErr = err
				break
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			copyErr = readErr
			break
		}
	}
	if closeErr := output.Close(); copyErr == nil && closeErr != nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return "", copyErr
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func sha256Range(handle *os.File, offset int64, size int64) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, io.NewSectionReader(handle, offset, size)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// SHA256File 计算文件摘要，供测试与诊断使用。
func SHA256File(file string) (string, error) {
	handle, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer func() { _ = handle.Close() }()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func safeRelativePath(value string) bool {
	if len(value) == 0 || len(value) > 512 {
		return false
	}
	if strings.ContainsAny(value, "\\\x00:") {
		return false
	}
	if strings.HasPrefix(value, "/") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// safePackagePath 在相对路径之上再排除 Windows 会静默改名的名字：
// 保留名、以点或空格结尾的段，否则两个不同的名字会落到同一个文件上。
func safePackagePath(value string) bool {
	if !safeRelativePath(value) {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if windowsReservedPattern.MatchString(segment) {
			return false
		}
		if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
			return false
		}
	}
	return true
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func randomHex(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// safeNonNegativeInteger 接受 JSON 的非负整数；超出 int64 的值按非法处理。
func safeNonNegativeInteger(value any) (int64, bool) {
	number, ok := numberValue(value)
	if !ok || number < 0 || math.Trunc(number) != number || number > math.MaxInt64 {
		return 0, false
	}
	return int64(number), true
}
