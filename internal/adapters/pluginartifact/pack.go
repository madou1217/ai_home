package pluginartifact

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	"github.com/madou1217/ai_home/internal/adapters/plugintrust"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// BuildOptions 配置一次离线打包。
type BuildOptions struct {
	// SigningKey 是 Ed25519 私钥 PEM 内容或私钥文件路径。
	SigningKey string
	// KeyID 覆盖默认 keyId（默认取公钥 PEM 的 sha256 前 24 位）。
	KeyID string
	// SignedAt 覆盖签名时间；零值使用当前时间。
	SignedAt time.Time
	// Target 覆盖宿主平台判定；空值按当前平台。
	Target string
	// HostVersion 覆盖宿主版本判定；空值使用默认值。
	HostVersion string
	// NodeVersion 覆盖引擎判定；空值不限制。
	NodeVersion string
}

// BuildSignature 是打包结果的签名摘要。
type BuildSignature struct {
	Status   string `json:"status"`
	KeyID    string `json:"keyId,omitempty"`
	SignedAt string `json:"signedAt,omitempty"`
}

// BuildResult 描述一次打包产物。
type BuildResult struct {
	File      string         `json:"file"`
	Digest    string         `json:"digest"`
	Bytes     int64          `json:"bytes"`
	Files     int            `json:"files"`
	Signature BuildSignature `json:"signature"`
}

// packFile 是包内一个待写入文件；生成文件（plugin.json）没有绝对路径。
type packFile struct {
	Path     string
	Absolute string
	Content  []byte
	Size     int64
	SHA256   string
}

// BuildArtifact 把插件源目录打成 .aih-plugin 制品。
//
// 格式与 Node artifact.js 完全一致：8 字节魔数 + 4 字节元数据长度 + JSON 元数据
// （manifest + 文件表，含每个文件的 sha256）+ 按文件表顺序拼接的内容。
func BuildArtifact(sourceDir, outputFile string, options BuildOptions) (BuildResult, error) {
	root := strings.TrimSpace(sourceDir)
	if root == "" {
		return BuildResult{}, pluginerr.New("plugin_package_source_invalid", "插件目录不能为空")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_source_invalid", "插件目录不可用")
	}
	info, err := os.Stat(absoluteRoot)
	if err != nil || !info.IsDir() {
		return BuildResult{}, pluginerr.New("plugin_package_source_invalid", "插件目录不存在或者不是目录")
	}
	source, err := ReadSourceManifest(absoluteRoot)
	if err != nil {
		return BuildResult{}, err
	}
	validated, err := ValidateManifest(source.Manifest, ManifestOptions{
		HostVersion: options.HostVersion,
		NodeVersion: options.NodeVersion,
		Target:      options.Target,
	})
	if err != nil {
		return BuildResult{}, err
	}
	// 校验结果可能包含内部规整类型；打包与签名只接受纯 JSON 值。
	manifest, err := toJSONMap(validated)
	if err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_metadata_invalid", "清单无法编码")
	}
	files, err := listSourceFiles(absoluteRoot)
	if err != nil {
		return BuildResult{}, err
	}
	if source.Generated {
		encoded, marshalErr := json.MarshalIndent(source.Manifest, "", "  ")
		if marshalErr != nil {
			return BuildResult{}, pluginerr.New("plugin_package_metadata_invalid", "无法生成 plugin.json")
		}
		files = append(files, packFile{Path: "plugin.json", Content: append(encoded, '\n')})
	}
	sort.Slice(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	if err := assertUniquePackagePaths(files); err != nil {
		return BuildResult{}, err
	}
	entry, _ := manifest["entry"].(string)
	entryFound := false
	records := make([]any, 0, len(files))
	for index := range files {
		file := &files[index]
		if file.Path == entry {
			entryFound = true
		}
		if file.Content == nil {
			data, readErr := os.ReadFile(file.Absolute)
			if readErr != nil {
				return BuildResult{}, pluginerr.New("plugin_package_file_invalid", "无法读取 "+file.Path)
			}
			file.Content = data
		}
		file.Size = int64(len(file.Content))
		digest := sha256.Sum256(file.Content)
		file.SHA256 = hex.EncodeToString(digest[:])
		records = append(records, map[string]any{
			"path":   file.Path,
			"size":   file.Size,
			"sha256": file.SHA256,
		})
	}
	if !entryFound {
		return BuildResult{}, pluginerr.New("plugin_entry_missing", "包内没有入口 "+entry)
	}
	if len(files) > plugincontract.MaxPackageFiles {
		return BuildResult{}, pluginerr.New("plugin_package_file_count", "插件包文件数超过上限")
	}
	metadata := map[string]any{
		"formatVersion": 1,
		"manifest":      manifest,
		"files":         records,
	}
	signature := BuildSignature{Status: "unsigned"}
	if strings.TrimSpace(options.SigningKey) != "" {
		signed, signedAt, keyID, signErr := signMetadata(metadata, options.SigningKey, options.KeyID, options.SignedAt)
		if signErr != nil {
			return BuildResult{}, signErr
		}
		metadata["signature"] = signed
		signature = BuildSignature{Status: "signed", KeyID: keyID, SignedAt: signedAt}
	}
	encodedMetadata, err := json.Marshal(metadata)
	if err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_metadata_invalid", "元数据无法编码")
	}
	if len(encodedMetadata) > plugincontract.MaxPackageMetadataBytes {
		return BuildResult{}, pluginerr.New("plugin_package_metadata_limit", "插件包元数据超过上限")
	}
	total := int64(headerBytes) + int64(len(encodedMetadata))
	for _, file := range files {
		total += file.Size
	}
	if total > plugincontract.MaxPackageBytes {
		return BuildResult{}, pluginerr.New("plugin_package_bytes_limit", "插件包超过大小上限")
	}
	output := strings.TrimSpace(outputFile)
	if output == "" {
		pluginID, _ := manifest["pluginId"].(string)
		version, _ := manifest["version"].(string)
		output = pluginID + "-" + version + ".aih-plugin"
	}
	absoluteOutput, err := filepath.Abs(output)
	if err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_output_invalid", "输出路径不可用")
	}
	if err := os.MkdirAll(filepath.Dir(absoluteOutput), 0o700); err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_output_invalid", "输出目录不可写")
	}
	header := make([]byte, headerBytes)
	copy(header, Magic)
	binary.BigEndian.PutUint32(header[len(Magic):], uint32(len(encodedMetadata)))
	file, err := os.OpenFile(absoluteOutput, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return BuildResult{}, pluginerr.New("plugin_package_output_invalid", "输出文件不可写")
	}
	writeErr := writeAll(file, header)
	if writeErr == nil {
		writeErr = writeAll(file, encodedMetadata)
	}
	for _, item := range files {
		if writeErr != nil {
			break
		}
		writeErr = writeAll(file, item.Content)
	}
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(absoluteOutput)
		return BuildResult{}, pluginerr.New("plugin_package_output_invalid", "写入插件包失败")
	}
	digest, err := sha256File(absoluteOutput)
	if err != nil {
		_ = os.Remove(absoluteOutput)
		return BuildResult{}, pluginerr.New("plugin_package_output_invalid", "无法计算插件包摘要")
	}
	return BuildResult{
		File:      absoluteOutput,
		Digest:    digest,
		Bytes:     total,
		Files:     len(files),
		Signature: signature,
	}, nil
}

func toJSONMap(value map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var normalized map[string]any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	return normalized, nil
}

func listSourceFiles(root string) ([]packFile, error) {
	files := make([]packFile, 0)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.Type()&os.ModeSymlink != 0 {
			return pluginerr.New("plugin_package_symlink", "不允许符号链接："+relative)
		}
		if entry.IsDir() {
			if !safePackagePath(relative) {
				return pluginerr.New("plugin_package_path_invalid", "非法路径："+relative)
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return pluginerr.New("plugin_package_entry_invalid", "不支持的文件类型："+relative)
		}
		if !safePackagePath(relative) {
			return pluginerr.New("plugin_package_path_invalid", "非法路径："+relative)
		}
		files = append(files, packFile{Path: relative, Absolute: path})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return files, nil
}

func assertUniquePackagePaths(files []packFile) error {
	seen := make(map[string]bool, len(files))
	for _, file := range files {
		folded := strings.ToLower(file.Path)
		if seen[folded] {
			return pluginerr.New("plugin_package_path_collision", "大小写不敏感的文件系统上会互相覆盖："+file.Path)
		}
		seen[folded] = true
	}
	return nil
}

func writeAll(file *os.File, data []byte) error {
	for len(data) > 0 {
		written, err := file.Write(data)
		if err != nil {
			return err
		}
		data = data[written:]
	}
	return nil
}

func sha256File(file string) (string, error) {
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

// signMetadata 为元数据生成 Ed25519 发布者签名。
//
// 签名覆盖 canonicalJson({formatVersion, manifest, files})，与 Node signMetadata
// 完全同构；keyId 默认取归一公钥 PEM 的 sha256 前 24 位。
func signMetadata(metadata map[string]any, signingKey string, keyID string, signedAt time.Time) (map[string]any, string, string, error) {
	privateKey, publicKeyPEM, err := loadSigningKey(signingKey)
	if err != nil {
		return nil, "", "", err
	}
	normalized, err := plugintrust.NormalizePublicKey(publicKeyPEM)
	if err != nil {
		return nil, "", "", pluginerr.New("plugin_signature_key_invalid", "签名私钥不能导出 Ed25519 公钥")
	}
	resolvedKeyID := strings.TrimSpace(keyID)
	if resolvedKeyID == "" {
		resolvedKeyID = plugintrust.Fingerprint(normalized)
	}
	if !validKeyID(resolvedKeyID) {
		return nil, "", "", pluginerr.New("plugin_signature_key_id_invalid", "keyId 只允许字母、数字、._:-")
	}
	payload, err := signedPayload(metadata)
	if err != nil {
		return nil, "", "", pluginerr.New("plugin_signature_invalid", "签名载荷无法编码："+err.Error())
	}
	signature := ed25519.Sign(privateKey, payload)
	if signedAt.IsZero() {
		signedAt = time.Now()
	}
	signedAtText := signedAt.UTC().Format("2006-01-02T15:04:05.000Z")
	return map[string]any{
		"algorithm": "ed25519",
		"keyId":     resolvedKeyID,
		"value":     base64.StdEncoding.EncodeToString(signature),
		"signedAt":  signedAtText,
	}, signedAtText, resolvedKeyID, nil
}

func loadSigningKey(value string) (ed25519.PrivateKey, string, error) {
	input := strings.TrimSpace(value)
	if input == "" {
		return nil, "", pluginerr.New("plugin_signing_key_invalid", "签名私钥不能为空")
	}
	pemText := input
	if !strings.Contains(input, "BEGIN") {
		data, err := os.ReadFile(input)
		if err != nil {
			return nil, "", pluginerr.New("plugin_signing_key_invalid", "私钥不是合法的 Ed25519 PEM 或文件")
		}
		pemText = string(data)
	}
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, "", pluginerr.New("plugin_signing_key_invalid", "私钥不是合法的 Ed25519 PEM 或文件")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, "", pluginerr.New("plugin_signing_key_invalid", "私钥不是合法的 Ed25519 PEM 或文件")
	}
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, "", pluginerr.New("plugin_signing_key_invalid", "只支持 Ed25519 私钥")
	}
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return nil, "", pluginerr.New("plugin_signing_key_invalid", "只支持 Ed25519 私钥")
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return nil, "", pluginerr.New("plugin_signature_key_invalid", "签名私钥不能导出 Ed25519 公钥")
	}
	publicPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return privateKey, publicPEM, nil
}

func validKeyID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for index, char := range value {
		allowed := (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '.' || char == '_' || char == ':' || char == '-'
		if !allowed {
			return false
		}
		if index == 0 && char == '-' {
			return false
		}
	}
	return true
}

// GenerateSigningKeyPair 生成 Ed25519 私钥/公钥 PEM 与 keyId，供 `aih plugin keygen` 使用。
func GenerateSigningKeyPair() (privatePEM string, publicPEM string, keyID string, err error) {
	publicKey, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		return "", "", "", fmt.Errorf("生成 Ed25519 密钥失败: %w", err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return "", "", "", fmt.Errorf("编码私钥失败: %w", err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", "", "", fmt.Errorf("编码公钥失败: %w", err)
	}
	privatePEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER}))
	publicPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER}))
	return privatePEM, publicPEM, plugintrust.Fingerprint(publicPEM), nil
}
