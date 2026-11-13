package remotebackup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"golang.org/x/crypto/ssh"
)

// SFTP v3 数据包类型与标志位（RFC draft-ietf-secsh-filexfer-02）。
const (
	sftpPacketInit     byte = 1
	sftpPacketVersion  byte = 2
	sftpPacketOpen     byte = 3
	sftpPacketClose    byte = 4
	sftpPacketRead     byte = 5
	sftpPacketWrite    byte = 6
	sftpPacketRemove   byte = 13
	sftpPacketMkdir    byte = 14
	sftpPacketRealpath byte = 16
	sftpPacketStat     byte = 17
	sftpPacketRename   byte = 18
	sftpPacketStatus   byte = 101
	sftpPacketHandle   byte = 102
	sftpPacketData     byte = 103
	sftpPacketName     byte = 104
	sftpPacketAttrs    byte = 105

	sftpStatusOK         uint32 = 0
	sftpStatusEOF        uint32 = 1
	sftpStatusNoSuchFile uint32 = 2

	sftpFlagRead  uint32 = 0x00000001
	sftpFlagWrite uint32 = 0x00000002
	sftpFlagCreat uint32 = 0x00000008
	sftpFlagTrunc uint32 = 0x00000010

	sftpAttrSize        uint32 = 0x00000001
	sftpAttrUIDGID      uint32 = 0x00000002
	sftpAttrPermissions uint32 = 0x00000004
	sftpAttrACModTime   uint32 = 0x00000008

	sftpMaxPacketBytes = 1024 * 1024
	sftpChunkBytes     = 32 * 1024
)

// SFTPStatusError 表示远端 SFTP 子系统返回了非 OK 状态码。
type SFTPStatusError struct {
	Code    uint32
	Message string
}

func (e *SFTPStatusError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("sftp status %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("sftp status %d", e.Code)
}

// IsNoSuchFile 判断错误是否为 SFTP status 2 (NO_SUCH_FILE)。
func IsNoSuchFile(err error) bool {
	var statusErr *SFTPStatusError
	return errors.As(err, &statusErr) && statusErr.Code == sftpStatusNoSuchFile
}

type sftpFileAttr struct {
	HasPermissions bool
	Permissions    uint32
}

func (a sftpFileAttr) IsDir() bool {
	return a.HasPermissions && (a.Permissions&0o170000 == 0o040000)
}

// sftpClient 是仅基于 golang.org/x/crypto/ssh 的最小 SFTP v3 客户端，避免引入额外第三方包。
type sftpClient struct {
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader

	mu     sync.Mutex
	nextID uint32
	closed bool
}

func newSFTPClient(client *ssh.Client) (*sftpClient, error) {
	session, err := client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("打开 SSH 会话失败: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("获取 SSH stdin 失败: %w", err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		_ = session.Close()
		return nil, fmt.Errorf("获取 SSH stdout 失败: %w", err)
	}
	if err := session.RequestSubsystem("sftp"); err != nil {
		_ = stdin.Close()
		_ = session.Close()
		return nil, fmt.Errorf("启动 SFTP 子系统失败: %w", err)
	}

	c := &sftpClient{
		session: session,
		stdin:   stdin,
		stdout:  stdout,
		nextID:  1,
	}
	if err := c.handshake(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func (c *sftpClient) handshake() error {
	var payload [4]byte
	binary.BigEndian.PutUint32(payload[:], 3)
	if err := c.writePacket(sftpPacketInit, payload[:]); err != nil {
		return fmt.Errorf("发送 SFTP INIT 失败: %w", err)
	}
	pktType, body, err := c.readPacket()
	if err != nil {
		return fmt.Errorf("读取 SFTP VERSION 失败: %w", err)
	}
	if pktType != sftpPacketVersion || len(body) < 4 {
		return fmt.Errorf("意外的 SFTP 握手包: type=%d", pktType)
	}
	version := binary.BigEndian.Uint32(body[:4])
	if version < 3 {
		return fmt.Errorf("远端 SFTP 协议版本过低: %d", version)
	}
	return nil
}

func (c *sftpClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	stdin := c.stdin
	session := c.session
	c.mu.Unlock()

	var errs []error
	if stdin != nil {
		errs = append(errs, stdin.Close())
	}
	if session != nil {
		errs = append(errs, session.Close())
	}
	return errors.Join(errs...)
}

func (c *sftpClient) Realpath(remotePath string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, remotePath)
	if err := c.writePacket(sftpPacketRealpath, buf); err != nil {
		return "", err
	}
	pktType, body, err := c.readResponseFor(reqID)
	if err != nil {
		return "", err
	}
	if pktType == sftpPacketStatus {
		return "", parseStatusError(body)
	}
	if pktType != sftpPacketName {
		return "", fmt.Errorf("意外的 realpath 响应包: %d", pktType)
	}
	if len(body) < 4 {
		return "", errors.New("realpath 响应截断")
	}
	count := binary.BigEndian.Uint32(body[:4])
	if count == 0 {
		return "", errors.New("realpath 未返回路径")
	}
	resolved, _, ok := readString(body[4:])
	if !ok {
		return "", errors.New("realpath 路径编码无效")
	}
	return resolved, nil
}

func (c *sftpClient) Stat(remotePath string) (sftpFileAttr, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, remotePath)
	if err := c.writePacket(sftpPacketStat, buf); err != nil {
		return sftpFileAttr{}, err
	}
	pktType, body, err := c.readResponseFor(reqID)
	if err != nil {
		return sftpFileAttr{}, err
	}
	if pktType == sftpPacketStatus {
		return sftpFileAttr{}, parseStatusError(body)
	}
	if pktType != sftpPacketAttrs {
		return sftpFileAttr{}, fmt.Errorf("意外的 stat 响应包: %d", pktType)
	}
	return parseFileAttr(body)
}

func (c *sftpClient) Mkdir(remotePath string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, remotePath)
	buf = appendUint32(buf, 0) // attrs flags = 0
	return c.sendAndExpectOK(sftpPacketMkdir, buf, reqID)
}

func (c *sftpClient) Remove(remotePath string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, remotePath)
	return c.sendAndExpectOK(sftpPacketRemove, buf, reqID)
}

func (c *sftpClient) Rename(oldPath, newPath string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, oldPath)
	buf = appendString(buf, newPath)
	return c.sendAndExpectOK(sftpPacketRename, buf, reqID)
}

func (c *sftpClient) ReadFile(remotePath string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	handle, err := c.openLocked(remotePath, sftpFlagRead, 0)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = c.closeHandleLocked(handle)
	}()

	var out []byte
	var offset uint64
	for {
		reqID := c.allocID()
		var buf []byte
		buf = appendUint32(buf, reqID)
		buf = appendBytes(buf, handle)
		buf = appendUint64(buf, offset)
		buf = appendUint32(buf, sftpChunkBytes)
		if err := c.writePacket(sftpPacketRead, buf); err != nil {
			return nil, err
		}
		pktType, body, err := c.readResponseFor(reqID)
		if err != nil {
			return nil, err
		}
		if pktType == sftpPacketStatus {
			statusErr := parseStatusError(body)
			if statusErr.Code == sftpStatusEOF {
				return out, nil
			}
			return nil, statusErr
		}
		if pktType != sftpPacketData {
			return nil, fmt.Errorf("意外的 read 响应包: %d", pktType)
		}
		chunk, _, ok := readBytes(body)
		if !ok {
			return nil, errors.New("SFTP read 数据编码无效")
		}
		if len(chunk) == 0 {
			return out, nil
		}
		out = append(out, chunk...)
		offset += uint64(len(chunk))
	}
}

func (c *sftpClient) WriteFile(remotePath string, data []byte, mode os.FileMode) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	handle, err := c.openLocked(remotePath, sftpFlagWrite|sftpFlagCreat|sftpFlagTrunc, uint32(mode))
	if err != nil {
		return err
	}
	defer func() {
		_ = c.closeHandleLocked(handle)
	}()

	var offset uint64
	for offset < uint64(len(data)) {
		end := offset + sftpChunkBytes
		if end > uint64(len(data)) {
			end = uint64(len(data))
		}
		chunk := data[offset:end]
		reqID := c.allocID()
		var buf []byte
		buf = appendUint32(buf, reqID)
		buf = appendBytes(buf, handle)
		buf = appendUint64(buf, offset)
		buf = appendBytes(buf, chunk)
		if err := c.sendAndExpectOK(sftpPacketWrite, buf, reqID); err != nil {
			return err
		}
		offset = end
	}
	return nil
}

func (c *sftpClient) openLocked(remotePath string, pflags uint32, mode uint32) ([]byte, error) {
	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendString(buf, remotePath)
	buf = appendUint32(buf, pflags)
	if mode != 0 {
		buf = appendUint32(buf, sftpAttrPermissions)
		buf = appendUint32(buf, mode)
	} else {
		buf = appendUint32(buf, 0)
	}
	if err := c.writePacket(sftpPacketOpen, buf); err != nil {
		return nil, err
	}
	pktType, body, err := c.readResponseFor(reqID)
	if err != nil {
		return nil, err
	}
	if pktType == sftpPacketStatus {
		return nil, parseStatusError(body)
	}
	if pktType != sftpPacketHandle {
		return nil, fmt.Errorf("意外的 open 响应包: %d", pktType)
	}
	handle, _, ok := readBytes(body)
	if !ok {
		return nil, errors.New("SFTP handle 编码无效")
	}
	return handle, nil
}

func (c *sftpClient) closeHandleLocked(handle []byte) error {
	reqID := c.allocID()
	var buf []byte
	buf = appendUint32(buf, reqID)
	buf = appendBytes(buf, handle)
	return c.sendAndExpectOK(sftpPacketClose, buf, reqID)
}

func (c *sftpClient) sendAndExpectOK(pktType byte, payload []byte, reqID uint32) error {
	if err := c.writePacket(pktType, payload); err != nil {
		return err
	}
	respType, body, err := c.readResponseFor(reqID)
	if err != nil {
		return err
	}
	if respType != sftpPacketStatus {
		return fmt.Errorf("意外的 SFTP 状态响应包: %d", respType)
	}
	statusErr := parseStatusError(body)
	if statusErr.Code != sftpStatusOK {
		return statusErr
	}
	return nil
}

func (c *sftpClient) allocID() uint32 {
	id := c.nextID
	c.nextID++
	return id
}

func (c *sftpClient) writePacket(pktType byte, payload []byte) error {
	if c.closed {
		return errors.New("sftp_closed")
	}
	totalLen := 1 + len(payload)
	header := make([]byte, 5)
	binary.BigEndian.PutUint32(header[:4], uint32(totalLen))
	header[4] = pktType
	if _, err := c.stdin.Write(header); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := c.stdin.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func (c *sftpClient) readPacket() (byte, []byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(c.stdout, lenBuf[:]); err != nil {
		return 0, nil, err
	}
	pktLen := binary.BigEndian.Uint32(lenBuf[:])
	if pktLen < 1 || pktLen > sftpMaxPacketBytes {
		return 0, nil, fmt.Errorf("SFTP 数据包长度非法: %d", pktLen)
	}
	frame := make([]byte, pktLen)
	if _, err := io.ReadFull(c.stdout, frame); err != nil {
		return 0, nil, err
	}
	return frame[0], frame[1:], nil
}

func (c *sftpClient) readResponseFor(expectedReqID uint32) (byte, []byte, error) {
	pktType, body, err := c.readPacket()
	if err != nil {
		return 0, nil, err
	}
	if len(body) < 4 {
		return 0, nil, errors.New("SFTP 响应缺少 request id")
	}
	respID := binary.BigEndian.Uint32(body[:4])
	if respID != expectedReqID {
		return 0, nil, fmt.Errorf("SFTP request id 不匹配: got=%d want=%d", respID, expectedReqID)
	}
	return pktType, body[4:], nil
}

func parseStatusError(body []byte) *SFTPStatusError {
	if len(body) < 4 {
		return &SFTPStatusError{Code: 4, Message: "truncated status"}
	}
	code := binary.BigEndian.Uint32(body[:4])
	msg, _, _ := readString(body[4:])
	return &SFTPStatusError{Code: code, Message: msg}
}

func parseFileAttr(body []byte) (sftpFileAttr, error) {
	if len(body) < 4 {
		return sftpFileAttr{}, errors.New("SFTP attrs 截断")
	}
	flags := binary.BigEndian.Uint32(body[:4])
	pos := 4
	if flags&sftpAttrSize != 0 {
		if pos+8 > len(body) {
			return sftpFileAttr{}, errors.New("SFTP attrs size 截断")
		}
		pos += 8
	}
	if flags&sftpAttrUIDGID != 0 {
		if pos+8 > len(body) {
			return sftpFileAttr{}, errors.New("SFTP attrs uid/gid 截断")
		}
		pos += 8
	}
	var attr sftpFileAttr
	if flags&sftpAttrPermissions != 0 {
		if pos+4 > len(body) {
			return sftpFileAttr{}, errors.New("SFTP attrs permissions 截断")
		}
		attr.HasPermissions = true
		attr.Permissions = binary.BigEndian.Uint32(body[pos : pos+4])
		pos += 4
	}
	_ = pos
	return attr, nil
}

func appendUint32(dst []byte, v uint32) []byte {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	return append(dst, b[:]...)
}

func appendUint64(dst []byte, v uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	return append(dst, b[:]...)
}

func appendBytes(dst []byte, v []byte) []byte {
	dst = appendUint32(dst, uint32(len(v)))
	return append(dst, v...)
}

func appendString(dst []byte, s string) []byte {
	return appendBytes(dst, []byte(s))
}

func readBytes(src []byte) ([]byte, []byte, bool) {
	if len(src) < 4 {
		return nil, nil, false
	}
	n := int(binary.BigEndian.Uint32(src[:4]))
	if n < 0 || 4+n > len(src) {
		return nil, nil, false
	}
	out := append([]byte(nil), src[4:4+n]...)
	return out, src[4+n:], true
}

func readString(src []byte) (string, []byte, bool) {
	b, rest, ok := readBytes(src)
	if !ok {
		return "", nil, false
	}
	return string(b), rest, true
}
