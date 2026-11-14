// Package serveridentity publishes the public Go daemon's non-secret runtime identity.
package serveridentity

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Publish is called only by the listening daemon, never MCP/remote helper modes.
// Cleanup removes only this process's unchanged record; a successor's record wins.
func Publish(aiHomeDir string, address net.Addr) (func(), error) {
	home, err := filepath.Abs(aiHomeDir)
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(home); err == nil {
		home = resolved
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(binary); err == nil {
		binary = resolved
	}
	file, err := os.Open(binary)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(hash, file)
	file.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	host, portText, err := net.SplitHostPort(address.String())
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, fmt.Errorf("invalid public daemon port")
	}
	startID, err := processStartID()
	if err != nil {
		return nil, err
	}
	record := struct {
		Version    int    `json:"version"`
		PID        int    `json:"pid"`
		AIHomeDir  string `json:"aiHomeDir"`
		Executable string `json:"executable"`
		SHA256     string `json:"binarySha256"`
		Host       string `json:"host"`
		Port       int    `json:"port"`
		StartedAt  string `json:"startedAt"`
		StartID    string `json:"processStartId"`
	}{1, os.Getpid(), home, binary, hex.EncodeToString(hash.Sum(nil)), host, port, time.Now().UTC().Format(time.RFC3339Nano), startID}
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(home, "run")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	target := filepath.Join(dir, "go-server-runtime.json")
	temp, err := os.CreateTemp(dir, ".go-server-runtime-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(encoded); err != nil {
		temp.Close()
		return nil, err
	}
	if err := temp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(temp.Name(), target); err != nil {
		return nil, err
	}
	return func() {
		if current, err := os.ReadFile(target); err == nil && bytes.Equal(current, encoded) {
			_ = os.Remove(target)
		}
	}, nil
}
