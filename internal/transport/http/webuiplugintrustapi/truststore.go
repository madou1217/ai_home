package webuiplugintrustapi

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// StoreSchemaVersion 是信任根文件的格式版本，与 Node 的 SIGNATURE_SCHEMA_VERSION 一致。
	StoreSchemaVersion = 1
	// StoreFileName 是信任根文件名，必须与 Node 的 TRUST_STORE_FILE 逐字一致：
	// Node 的 install 校验直接读这个文件，改名等于让已签名插件全部失效。
	StoreFileName = "trusted-keys.json"
	// Algorithm 是唯一支持的发布者签名算法。
	Algorithm = "ed25519"
)

// 错误码与 Node 插件错误码逐字一致：WebUI 与 CLI 都按这些字符串分支。
const (
	CodeSignatureKeyInvalid   = "plugin_signature_key_invalid"
	CodeSignatureKeyIDInvalid = "plugin_signature_key_id_invalid"
	CodeTrustStoreInvalid     = "plugin_trust_store_invalid"
)

// keyIDPattern 与 Node 的 KEY_ID_PATTERN 逐字一致。
var keyIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`)

// Error 是带错误码的信任根错误；Code 直接作为 /v0/plugins 的 error 字段返回，
// Message 与 Node 的 PluginError.message 对齐（空时由 handler 回落到 Code）。
type Error struct {
	Code    string
	Message string
}

func (err *Error) Error() string {
	if err == nil {
		return ""
	}
	return err.Message
}

func keyError(code string, message string) *Error {
	return &Error{Code: code, Message: message}
}

// TrustStore 读写 <aiHomeDir>/plugins/trusted-keys.json。
//
// 刻意不做进程内缓存：Node 的 install 校验与 CLI 的 trust/untrust 都直接读同一个文件，
// 缓存会让「CLI 刚加入的公钥」在 Go 这边看不见，签名校验就会误判为 untrusted。
type TrustStore struct {
	aiHomeDir string
	now       func() time.Time
}

// NewTrustStore 创建信任根存储。
//
// aiHomeDir 为空时拒绝创建：Node 的空目录会按进程 CWD 拼出相对路径，
// 那会把信任根写到启动目录里，必须由装配方给出真实数据根。
func NewTrustStore(aiHomeDir string) (*TrustStore, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("信任根存储缺少 aiHomeDir")
	}
	return &TrustStore{aiHomeDir: root, now: time.Now}, nil
}

// File 返回信任根文件路径，与 Node trustStorePath 的拼法一致。
func (store *TrustStore) File() string {
	return filepath.Join(store.aiHomeDir, "plugins", StoreFileName)
}

// NormalizePublicKey 校验并归一 Ed25519 公钥 PEM。
//
// Node 用 crypto.createPublicKey + export({type:'spki'}) 做归一：同一把密钥即使
// 文本格式不同（多余空行、CRLF）也会得到同一串 PEM，keyId 与 fingerprint 才稳定。
func NormalizePublicKey(value string) (string, error) {
	input := strings.TrimSpace(value)
	if input == "" {
		return "", keyError(CodeSignatureKeyInvalid, "公钥不能为空")
	}
	block, _ := pem.Decode([]byte(input))
	if block == nil {
		return "", keyError(CodeSignatureKeyInvalid, "公钥不是合法的 Ed25519 PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		// RSA PKCS#1 能被 Node 的 createPublicKey 识别，所以它属于「不是 Ed25519」，
		// 而不是「不是合法 PEM」；错误文案要与 Node 对齐。
		if _, rsaErr := x509.ParsePKCS1PublicKey(block.Bytes); rsaErr == nil {
			return "", keyError(CodeSignatureKeyInvalid, "只支持 Ed25519 公钥")
		}
		return "", keyError(CodeSignatureKeyInvalid, "公钥不是合法的 Ed25519 PEM")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return "", keyError(CodeSignatureKeyInvalid, "只支持 Ed25519 公钥")
	}
	der, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", keyError(CodeSignatureKeyInvalid, "公钥不是合法的 Ed25519 PEM")
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

// Fingerprint 是 Node publicKeyId 的同构实现：sha256(归一后的 PEM) 前 24 位 hex。
//
// 注意是对 PEM 文本求哈希，不是对 DER 或原始公钥字节求哈希；换算法会让本机所有
// 已登记的 keyId 失效。
func Fingerprint(publicKeyPEM string) string {
	digest := sha256.Sum256([]byte(publicKeyPEM))
	return hex.EncodeToString(digest[:])[:24]
}

// Read 返回 keyId → 归一后的 PEM。
//
// 与 Node readTrustedKeys 一致：文件不存在是空信任根；JSON 语法错误是领域错误；
// 单条记录坏（keyId 不合法、缺 publicKeyPem、PEM 不是 Ed25519）跳过而不是整份失败——
// 否则一把手工写坏的公钥会让所有已签名插件都装不上。
func (store *TrustStore) Read() (map[string]string, error) {
	file := store.File()
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, keyError(CodeTrustStoreInvalid, fmt.Sprintf("信任根文件不可读：%s", file))
	}
	if !json.Valid(data) {
		return nil, keyError(CodeTrustStoreInvalid, fmt.Sprintf("信任根文件不是合法 JSON：%s", file))
	}
	var document struct {
		Keys json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		// 语法合法但根不是对象：Node 此时 document.keys 是 undefined，按空信任根处理。
		return map[string]string{}, nil
	}
	if len(document.Keys) == 0 {
		return map[string]string{}, nil
	}
	var records map[string]json.RawMessage
	if err := json.Unmarshal(document.Keys, &records); err != nil {
		// keys 不是对象：Node 只在 typeof === 'object' 时遍历，数组会退化成下标键、
		// 必然被条目校验丢掉。这里统一按空集合处理，不把形状问题升级成整份失败。
		return map[string]string{}, nil
	}
	keys := make(map[string]string, len(records))
	for keyID, raw := range records {
		if !keyIDPattern.MatchString(keyID) {
			continue
		}
		var record struct {
			PublicKeyPEM string `json:"publicKeyPem"`
		}
		if err := json.Unmarshal(raw, &record); err != nil {
			continue
		}
		normalized, normalizeErr := NormalizePublicKey(record.PublicKeyPEM)
		if normalizeErr != nil {
			continue
		}
		keys[keyID] = normalized
	}
	return keys, nil
}

// trustRecord 是文件里单条公钥记录，字段名与 Node 逐字一致。
type trustRecord struct {
	PublicKeyPEM string `json:"publicKeyPem"`
	AddedAt      string `json:"addedAt"`
}

// trustDocument 是整份信任根文件；Keys 用 map 编码，encoding/json 会按键排序。
type trustDocument struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Keys          map[string]trustRecord `json:"keys"`
}

// Write 原子替换信任根文件：同目录临时文件 + rename，目录 0700、文件 0600。
//
// 为什么每次都重写 addedAt：与 Node writeTrustedKeys 一致——它按当前时间重建所有记录。
// 若这里只给新 key 写 addedAt，同一个文件在两条写路径下就会产出两种形状。
func (store *TrustStore) Write(keys map[string]string) (string, error) {
	file := store.File()
	directory := filepath.Dir(file)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return file, keyError(CodeTrustStoreInvalid, fmt.Sprintf("信任根目录不可写：%s", directory))
	}
	addedAt := store.now().UTC().Format("2006-01-02T15:04:05.000Z")
	document := trustDocument{
		SchemaVersion: StoreSchemaVersion,
		Keys:          make(map[string]trustRecord, len(keys)),
	}
	for keyID, publicKeyPEM := range keys {
		document.Keys[keyID] = trustRecord{PublicKeyPEM: publicKeyPEM, AddedAt: addedAt}
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// Node 的 JSON.stringify 不转义 <>&；PEM 里没有这些字符，但格式要能逐字节对拍。
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return file, keyError(CodeTrustStoreInvalid, "信任根文件编码失败")
	}
	temp := fmt.Sprintf("%s.%d.%s.tmp", file, os.Getpid(), randomSuffix())
	if err := os.WriteFile(temp, buffer.Bytes(), 0o600); err != nil {
		return file, keyError(CodeTrustStoreInvalid, fmt.Sprintf("信任根文件不可写：%s", file))
	}
	if err := os.Rename(temp, file); err != nil {
		_ = os.Remove(temp)
		return file, keyError(CodeTrustStoreInvalid, fmt.Sprintf("信任根文件不可写：%s", file))
	}
	return file, nil
}

// randomSuffix 生成临时文件名后缀，与 Node 的 crypto.randomBytes(4) 同义。
func randomSuffix() string {
	var buffer [4]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buffer[:])
}

// AddInput 是一次 trust 请求的输入；与 Node 一样 publicKey 为空时才回落到 publicKeyPem。
type AddInput struct {
	PublicKey string
	KeyID     string
}

// AddResult 与 Node addTrustedKey 的返回字段逐字对应。
type AddResult struct {
	KeyID       string
	Fingerprint string
	File        string
}

// Add 把一把公钥写入信任根；重复登记同一把公钥是幂等的（覆盖同一条记录）。
func (store *TrustStore) Add(input AddInput) (AddResult, error) {
	publicKeyPEM, err := NormalizePublicKey(input.PublicKey)
	if err != nil {
		return AddResult{}, err
	}
	keyID := strings.TrimSpace(input.KeyID)
	if keyID == "" {
		keyID = Fingerprint(publicKeyPEM)
	}
	if !keyIDPattern.MatchString(keyID) {
		return AddResult{}, keyError(CodeSignatureKeyIDInvalid, "keyId 只允许字母、数字、._:-")
	}
	keys, err := store.Read()
	if err != nil {
		return AddResult{}, err
	}
	keys[keyID] = publicKeyPEM
	file, err := store.Write(keys)
	if err != nil {
		return AddResult{}, err
	}
	return AddResult{KeyID: keyID, Fingerprint: Fingerprint(publicKeyPEM), File: file}, nil
}

// RemoveResult 与 Node removeTrustedKey 的返回字段逐字对应。
type RemoveResult struct {
	KeyID   string
	Removed bool
	File    string
}

// Remove 按 keyId 撤销公钥；不存在的 keyId 是幂等 no-op（removed=false，不重写文件）。
//
// 与 Node 一致：这里只要求 keyId 非空，不校验字符集——不存在的字符串删不掉任何东西，
// 提前报「格式非法」只会让调用方多一条无意义的错误分支。
func (store *TrustStore) Remove(keyID string) (RemoveResult, error) {
	id := strings.TrimSpace(keyID)
	if id == "" {
		// Node 的 PluginError 默认 message 等于 code，这里显式写成同一个字符串。
		return RemoveResult{}, keyError(CodeSignatureKeyIDInvalid, CodeSignatureKeyIDInvalid)
	}
	keys, err := store.Read()
	if err != nil {
		return RemoveResult{}, err
	}
	_, removed := keys[id]
	delete(keys, id)
	if removed {
		if _, err := store.Write(keys); err != nil {
			return RemoveResult{}, err
		}
	}
	return RemoveResult{KeyID: id, Removed: removed, File: store.File()}, nil
}

// TrustedKey 是 GET /trusted 的列表项，字段与 Node listTrustedKeys 一致。
type TrustedKey struct {
	KeyID       string `json:"keyId"`
	Fingerprint string `json:"fingerprint"`
	Algorithm   string `json:"algorithm"`
}

// List 返回全部可信公钥。
//
// Node 按文件里的 JSON 键顺序返回；Go 的 map 无序，这里按 keyId 排序，
// 让「CLI 写、Go 读」与「Go 写、CLI 读」两种情况都有稳定顺序。Node 写入本身
// 也是排序的，正常文件下两者顺序一致。
func (store *TrustStore) List() ([]TrustedKey, error) {
	keys, err := store.Read()
	if err != nil {
		return nil, err
	}
	identifiers := make([]string, 0, len(keys))
	for keyID := range keys {
		identifiers = append(identifiers, keyID)
	}
	sort.Strings(identifiers)
	list := make([]TrustedKey, 0, len(identifiers))
	for _, keyID := range identifiers {
		list = append(list, TrustedKey{
			KeyID:       keyID,
			Fingerprint: Fingerprint(keys[keyID]),
			Algorithm:   Algorithm,
		})
	}
	return list, nil
}
