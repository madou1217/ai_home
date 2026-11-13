package remotebackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type testSFTPServer struct {
	t                   *testing.T
	rootDir             string
	addr                string
	hostFP              string
	listener            net.Listener
	failRenameOverwrite bool
	mu                  sync.Mutex
	wg                  sync.WaitGroup
}

func startTestSSHServer(t *testing.T, expectedUser, expectedPassword string, allowedPubKey ssh.PublicKey) *testSFTPServer {
	t.Helper()
	rootDir := t.TempDir()

	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	fpSum := sha256.Sum256(hostSigner.PublicKey().Marshal())
	hostFP := strings.ToLower(hex.EncodeToString(fpSum[:]))

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if c.User() == expectedUser && subtle.ConstantTimeCompare(pass, []byte(expectedPassword)) == 1 {
				return nil, nil
			}
			return nil, errors.New("rejected password")
		},
		PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if c.User() == expectedUser && allowedPubKey != nil && subtle.ConstantTimeCompare(key.Marshal(), allowedPubKey.Marshal()) == 1 {
				return nil, nil
			}
			return nil, errors.New("rejected public key")
		},
	}
	cfg.AddHostKey(hostSigner)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}

	srv := &testSFTPServer{
		t:        t,
		rootDir:  rootDir,
		addr:     ln.Addr().String(),
		hostFP:   hostFP,
		listener: ln,
	}

	srv.wg.Add(1)
	go func() {
		defer srv.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			srv.wg.Add(1)
			go func(c net.Conn) {
				defer srv.wg.Done()
				srv.handleConn(c, cfg)
			}(conn)
		}
	}()

	t.Cleanup(func() {
		_ = ln.Close()
		srv.wg.Wait()
	})
	return srv
}

func (s *testSFTPServer) handleConn(rawConn net.Conn, cfg *ssh.ServerConfig) {
	defer rawConn.Close()
	sshConn, chans, reqs, err := ssh.NewServerConn(rawConn, cfg)
	if err != nil {
		return
	}
	defer sshConn.Close()

	go func() {
		for req := range reqs {
			if req.WantReply {
				_ = req.Reply(req.Type == "keepalive@openssh.com", nil)
			}
		}
	}()

	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unknown channel type")
			continue
		}
		ch, requests, err := newChannel.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer ch.Close()
			for req := range requests {
				if req.Type == "subsystem" && len(req.Payload) >= 4 {
					subLen := int(binary.BigEndian.Uint32(req.Payload[:4]))
					if 4+subLen <= len(req.Payload) && string(req.Payload[4:4+subLen]) == "sftp" {
						if req.WantReply {
							_ = req.Reply(true, nil)
						}
						s.serveSFTP(ch)
						return
					}
				}
				if req.WantReply {
					_ = req.Reply(false, nil)
				}
			}
		}()
	}
}

func (s *testSFTPServer) mapLocal(remote string) (string, error) {
	cleaned := path.Clean("/" + strings.TrimSpace(remote))
	rel := strings.TrimPrefix(cleaned, "/")
	if rel == "home" || strings.HasPrefix(rel, "home/") {
		rel = strings.TrimPrefix(strings.TrimPrefix(rel, "home"), "/")
	}
	full := filepath.Join(s.rootDir, filepath.FromSlash(rel))
	if full != s.rootDir && !strings.HasPrefix(full, s.rootDir+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	return full, nil
}

func (s *testSFTPServer) serveSFTP(rw io.ReadWriter) {
	handles := make(map[string]*os.File)
	defer func() {
		for _, f := range handles {
			_ = f.Close()
		}
	}()
	nextHandle := 0

	for {
		var lenBuf [4]byte
		if _, err := io.ReadFull(rw, lenBuf[:]); err != nil {
			return
		}
		pktLen := binary.BigEndian.Uint32(lenBuf[:])
		if pktLen == 0 || pktLen > sftpMaxPacketBytes {
			return
		}
		buf := make([]byte, pktLen)
		if _, err := io.ReadFull(rw, buf); err != nil {
			return
		}
		pktType := buf[0]
		body := buf[1:]

		switch pktType {
		case sftpPacketInit:
			var out [4]byte
			binary.BigEndian.PutUint32(out[:], 3)
			_ = writeServerPacket(rw, sftpPacketVersion, out[:])

		case sftpPacketRealpath:
			reqID, rest, ok := readUint32(body)
			if !ok {
				return
			}
			rawPath, _, _ := readString(rest)
			resolved := "/home"
			if strings.HasPrefix(rawPath, "/") {
				resolved = path.Clean(rawPath)
			} else if rawPath != "" && rawPath != "." {
				resolved = path.Clean("/home/" + rawPath)
			}
			var out []byte
			out = appendUint32(out, reqID)
			out = appendUint32(out, 1)
			out = appendString(out, resolved)
			out = appendString(out, resolved)
			out = appendUint32(out, 0)
			_ = writeServerPacket(rw, sftpPacketName, out)

		case sftpPacketStat:
			reqID, rest, _ := readUint32(body)
			rawPath, _, _ := readString(rest)
			local, err := s.mapLocal(rawPath)
			if err != nil {
				sendServerStatus(rw, reqID, 3, err.Error())
				continue
			}
			info, err := os.Stat(local)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					sendServerStatus(rw, reqID, sftpStatusNoSuchFile, "no such file")
				} else {
					sendServerStatus(rw, reqID, 4, err.Error())
				}
				continue
			}
			perm := uint32(info.Mode().Perm()) | 0o100000
			if info.IsDir() {
				perm = uint32(info.Mode().Perm()) | 0o40000
			}
			var out []byte
			out = appendUint32(out, reqID)
			out = appendUint32(out, sftpAttrSize|sftpAttrPermissions)
			out = appendUint64(out, uint64(info.Size()))
			out = appendUint32(out, perm)
			_ = writeServerPacket(rw, sftpPacketAttrs, out)

		case sftpPacketMkdir:
			reqID, rest, _ := readUint32(body)
			rawPath, _, _ := readString(rest)
			local, err := s.mapLocal(rawPath)
			if err != nil {
				sendServerStatus(rw, reqID, 3, err.Error())
				continue
			}
			if err := os.Mkdir(local, 0o755); err != nil {
				sendServerStatus(rw, reqID, 4, err.Error())
				continue
			}
			sendServerStatus(rw, reqID, sftpStatusOK, "ok")

		case sftpPacketOpen:
			reqID, rest, _ := readUint32(body)
			rawPath, rest, _ := readString(rest)
			pflags, _, _ := readUint32(rest)
			local, err := s.mapLocal(rawPath)
			if err != nil {
				sendServerStatus(rw, reqID, 3, err.Error())
				continue
			}
			flags := 0
			hasR := (pflags & sftpFlagRead) != 0
			hasW := (pflags & sftpFlagWrite) != 0
			switch {
			case hasR && hasW:
				flags |= os.O_RDWR
			case hasW:
				flags |= os.O_WRONLY
			default:
				flags |= os.O_RDONLY
			}
			if (pflags & sftpFlagCreat) != 0 {
				flags |= os.O_CREATE
			}
			if (pflags & sftpFlagTrunc) != 0 {
				flags |= os.O_TRUNC
			}
			f, err := os.OpenFile(local, flags, 0o600)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					sendServerStatus(rw, reqID, sftpStatusNoSuchFile, "no such file")
				} else {
					sendServerStatus(rw, reqID, 4, err.Error())
				}
				continue
			}
			nextHandle++
			h := string([]byte{byte(nextHandle), byte(nextHandle >> 8), byte(nextHandle >> 16), byte(nextHandle >> 24)})
			handles[h] = f
			var out []byte
			out = appendUint32(out, reqID)
			out = appendBytes(out, []byte(h))
			_ = writeServerPacket(rw, sftpPacketHandle, out)

		case sftpPacketRead:
			reqID, rest, _ := readUint32(body)
			hBytes, rest, _ := readBytes(rest)
			offset, rest, _ := readUint64(rest)
			count, _, _ := readUint32(rest)
			f := handles[string(hBytes)]
			if f == nil {
				sendServerStatus(rw, reqID, 4, "bad handle")
				continue
			}
			chunk := make([]byte, count)
			n, err := f.ReadAt(chunk, int64(offset))
			if n > 0 {
				var out []byte
				out = appendUint32(out, reqID)
				out = appendBytes(out, chunk[:n])
				_ = writeServerPacket(rw, sftpPacketData, out)
				continue
			}
			if errors.Is(err, io.EOF) {
				sendServerStatus(rw, reqID, sftpStatusEOF, "eof")
				continue
			}
			sendServerStatus(rw, reqID, 4, err.Error())

		case sftpPacketWrite:
			reqID, rest, _ := readUint32(body)
			hBytes, rest, _ := readBytes(rest)
			offset, rest, _ := readUint64(rest)
			data, _, _ := readBytes(rest)
			f := handles[string(hBytes)]
			if f == nil {
				sendServerStatus(rw, reqID, 4, "bad handle")
				continue
			}
			if _, err := f.WriteAt(data, int64(offset)); err != nil {
				sendServerStatus(rw, reqID, 4, err.Error())
				continue
			}
			sendServerStatus(rw, reqID, sftpStatusOK, "ok")

		case sftpPacketClose:
			reqID, rest, _ := readUint32(body)
			hBytes, _, _ := readBytes(rest)
			if f := handles[string(hBytes)]; f != nil {
				delete(handles, string(hBytes))
				_ = f.Close()
			}
			sendServerStatus(rw, reqID, sftpStatusOK, "ok")

		case sftpPacketRemove:
			reqID, rest, _ := readUint32(body)
			rawPath, _, _ := readString(rest)
			local, err := s.mapLocal(rawPath)
			if err != nil {
				sendServerStatus(rw, reqID, 3, err.Error())
				continue
			}
			if err := os.Remove(local); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					sendServerStatus(rw, reqID, sftpStatusNoSuchFile, "no such file")
				} else {
					sendServerStatus(rw, reqID, 4, err.Error())
				}
				continue
			}
			sendServerStatus(rw, reqID, sftpStatusOK, "ok")

		case sftpPacketRename:
			reqID, rest, _ := readUint32(body)
			oldRaw, rest, _ := readString(rest)
			newRaw, _, _ := readString(rest)
			oldLocal, err1 := s.mapLocal(oldRaw)
			newLocal, err2 := s.mapLocal(newRaw)
			if err1 != nil || err2 != nil {
				sendServerStatus(rw, reqID, 3, "permission denied")
				continue
			}
			s.mu.Lock()
			failOverwrite := s.failRenameOverwrite
			s.mu.Unlock()
			if failOverwrite {
				if _, err := os.Stat(newLocal); err == nil {
					sendServerStatus(rw, reqID, 4, "destination exists")
					continue
				}
			}
			if err := os.Rename(oldLocal, newLocal); err != nil {
				sendServerStatus(rw, reqID, 4, err.Error())
				continue
			}
			sendServerStatus(rw, reqID, sftpStatusOK, "ok")

		default:
			if len(body) >= 4 {
				reqID := binary.BigEndian.Uint32(body[:4])
				sendServerStatus(rw, reqID, 8, "unsupported")
			}
		}
	}
}

func writeServerPacket(w io.Writer, pktType byte, body []byte) error {
	var hdr [5]byte
	binary.BigEndian.PutUint32(hdr[:4], uint32(1+len(body)))
	hdr[4] = pktType
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(body) > 0 {
		if _, err := w.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func sendServerStatus(w io.Writer, reqID, code uint32, msg string) {
	var out []byte
	out = appendUint32(out, reqID)
	out = appendUint32(out, code)
	out = appendString(out, msg)
	out = appendString(out, "en")
	_ = writeServerPacket(w, sftpPacketStatus, out)
}

func readUint32(src []byte) (uint32, []byte, bool) {
	if len(src) < 4 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint32(src[:4]), src[4:], true
}

func readUint64(src []byte) (uint64, []byte, bool) {
	if len(src) < 8 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint64(src[:8]), src[8:], true
}

func TestSSHStrategyEndToEndTOFUIncrementalKeyAuthAndOverwriteFallback(t *testing.T) {
	pubKeyRaw, privKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pubKeyRaw)
	if err != nil {
		t.Fatal(err)
	}
	pemBlock, err := ssh.MarshalPrivateKey(privKey, "")
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(pemBlock), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := startTestSSHServer(t, "backupuser", "pw-secret", sshPub)
	host, portStr, err := net.SplitHostPort(srv.addr)
	if err != nil {
		t.Fatal(err)
	}
	var port int
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}

	aiHome := t.TempDir()
	_, err = WriteBackupConfig(aiHome, BackupConfig{
		Version:         1,
		Enabled:         true,
		IntervalMinutes: 60,
		DebounceSeconds: 15,
		Targets: []BackupTarget{{
			ID:          "loopback",
			Strategy:    "ssh",
			Enabled:     true,
			Host:        host,
			Port:        port,
			Username:    "backupuser",
			RemoteDir:   ".aih-backup",
			PasswordEnv: "TEST_BACKUP_PW",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}

	rec := AccountRecord{
		Provider:     "codex",
		AccountRef:   "acct_0123456789abcdef0123",
		CLIAccountID: "1",
		Status:       "up",
		Env:          map[string]string{"OPENAI_API_KEY": "sk-loopback"},
		NativeAuth:   map[string]any{},
	}

	// Pass 1: Password auth + TOFU fingerprint recording + initial upload.
	res1, err := RunRemoteBackup(context.Background(), ServiceOptions{
		AIHomeDir: aiHome,
		HostName:  "mac-test",
		Env: func(k string) string {
			if k == "TEST_BACKUP_PW" {
				return "pw-secret"
			}
			return ""
		},
		Exporter: stubExporter{res: ExportResult{Accounts: []AccountRecord{rec}}},
	}, RunOptions{})
	if err != nil {
		t.Fatalf("RunRemoteBackup(pass1) err = %v", err)
	}
	if !res1.OK || len(res1.Targets) != 1 || res1.Targets[0].Uploaded != 1 || res1.Targets[0].Revision != 1 {
		t.Fatalf("res1 = %+v", res1)
	}

	cfgAfterTOFU, err := ReadBackupConfig(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	if cfgAfterTOFU.Targets[0].HostKeyFingerprint != srv.hostFP {
		t.Fatalf("TOFU fingerprint = %q, want %q", cfgAfterTOFU.Targets[0].HostKeyFingerprint, srv.hostFP)
	}

	// Switch to key-file auth and enable Windows-style rename-overwrite refusal.
	srv.mu.Lock()
	srv.failRenameOverwrite = true
	srv.mu.Unlock()

	cfgAfterTOFU.Targets[0].PasswordEnv = ""
	cfgAfterTOFU.Targets[0].IdentityFile = keyPath
	if _, err := WriteBackupConfig(aiHome, cfgAfterTOFU); err != nil {
		t.Fatal(err)
	}

	// Pass 2: Incremental unchanged -> 0 uploaded, 1 unchanged, revision still 1.
	res2, err := RunRemoteBackup(context.Background(), ServiceOptions{
		AIHomeDir: aiHome,
		HostName:  "mac-test",
		Exporter:  stubExporter{res: ExportResult{Accounts: []AccountRecord{rec}}},
	}, RunOptions{})
	if err != nil {
		t.Fatalf("RunRemoteBackup(pass2) err = %v", err)
	}
	if !res2.OK || res2.Targets[0].Uploaded != 0 || res2.Targets[0].Unchanged != 1 || res2.Targets[0].Revision != 1 {
		t.Fatalf("res2 = %+v", res2)
	}

	// Pass 3: Account updated + failRenameOverwrite=true exercises Windows Remove+Rename fallback!
	rec.Env["OPENAI_API_KEY"] = "sk-rotated"
	res3, err := RunRemoteBackup(context.Background(), ServiceOptions{
		AIHomeDir: aiHome,
		HostName:  "mac-test",
		Exporter:  stubExporter{res: ExportResult{Accounts: []AccountRecord{rec}}},
	}, RunOptions{})
	if err != nil {
		t.Fatalf("RunRemoteBackup(pass3) err = %v", err)
	}
	if !res3.OK || res3.Targets[0].Uploaded != 1 || res3.Targets[0].Revision != 2 {
		t.Fatalf("res3 = %+v", res3)
	}

	// Pass 4: Mismatched hostKeyFingerprint must reject connection cleanly.
	badTarget := cfgAfterTOFU.Targets[0]
	badTarget.HostKeyFingerprint = strings.Repeat("0", 64)
	strat := NewSSHBackupStrategy(badTarget, SSHStrategyDeps{ReadyTimeout: 3 * time.Second})
	if err := strat.Connect(context.Background()); err == nil || !strings.Contains(err.Error(), "指纹不匹配") {
		_ = strat.Close()
		t.Fatalf("expected fingerprint mismatch error, got %v", err)
	}

	// Verify ReadFile missing file returns found=false, err=nil.
	stratOK := NewSSHBackupStrategy(cfgAfterTOFU.Targets[0], SSHStrategyDeps{ReadyTimeout: 3 * time.Second})
	defer func() { _ = stratOK.Close() }()
	_, found, err := stratOK.ReadFile(context.Background(), "does-not-exist.json")
	if err != nil || found {
		t.Fatalf("ReadFile(missing) = (%v, %v), want found=false err=nil", found, err)
	}
}
