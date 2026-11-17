// Package accountdeletionmarker persists the private Node deletion fence with
// native write-through publication on Windows, where Node directory fsync fails.
package accountdeletionmarker

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

type Record struct {
	Version    int    `json:"version"`
	Prepared   bool   `json:"prepared"`
	Token      string `json:"token"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
}
type input struct {
	Action string `json:"action"`
	Record Record `json:"record"`
}

var tokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var providerPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
var refPattern = regexp.MustCompile(`^acct_[0-9a-f]{20}$`)

func Run(home string, source io.Reader) error {
	var in input
	raw, err := io.ReadAll(io.LimitReader(source, 8193))
	if err != nil || len(raw) > 8192 {
		return errors.New("deletion_marker_input_invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&in) != nil {
		return errors.New("deletion_marker_input_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("deletion_marker_input_invalid")
	}
	if (in.Action != "write" && in.Action != "remove") || in.Record.Version != 1 || !in.Record.Prepared || !tokenPattern.MatchString(in.Record.Token) || !providerPattern.MatchString(in.Record.Provider) || !refPattern.MatchString(in.Record.AccountRef) {
		return errors.New("deletion_marker_input_invalid")
	}
	if !filepath.IsAbs(home) {
		return errors.New("deletion_marker_home_invalid")
	}
	root, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	dir := root
	for _, part := range []string{"run", "account-deletion-prepared"} {
		dir = filepath.Join(dir, part)
		if err = os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return err
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("deletion_marker_directory_invalid")
		}
	}
	target := filepath.Join(dir, in.Record.Token+".json")
	same := func() (bool, error) {
		info, err := os.Lstat(target)
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 4096 {
			return false, errors.New("deletion_marker_file_invalid")
		}
		data, err := os.ReadFile(target)
		if err != nil {
			return false, err
		}
		var current Record
		if json.Unmarshal(data, &current) != nil || current != in.Record {
			return false, errors.New("deletion_marker_identity_changed")
		}
		return true, nil
	}
	exists, err := same()
	if err != nil {
		return err
	}
	if in.Action == "remove" {
		if !exists {
			return nil
		}
		// Removing by durable move makes the marker cease being an admission record
		// before cleanup of the harmless retired file. Never replace another marker.
		retired, err := os.CreateTemp(dir, ".retired-marker-*")
		if err != nil {
			return err
		}
		retiredPath := retired.Name()
		retired.Close()
		if err = os.Remove(retiredPath); err != nil {
			return err
		}
		if err = publish(target, retiredPath); err != nil {
			return err
		}
		return os.Remove(retiredPath)
	}
	if exists {
		return nil
	}
	data, err := json.Marshal(in.Record)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".deletion-marker-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return publish(file.Name(), target)
}
