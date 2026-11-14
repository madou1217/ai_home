package nativeterminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"path/filepath"
	"strings"
	"time"
)

func token() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func registryDir(home string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", ErrInvalid
	}
	return filepath.Join(home, "run", "persistent-sessions"), nil
}
func entryPath(home, socket, session string) (string, error) {
	if !safePart.MatchString(socket) || !safePart.MatchString(session) {
		return "", ErrInvalid
	}
	dir, err := registryDir(home)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, socket+"--"+session+".json"), nil
}

// withEntryLock serializes the outer, pane and close processes. A dead writer's
// lock is reclaimed only after confirming its PID no longer exists.
func withEntryLock(ctx context.Context, path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock := path + ".native-lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		file, err := os.OpenFile(lock, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			_, werr := fmt.Fprintf(file, "%d", os.Getpid())
			cerr := file.Close()
			if werr != nil || cerr != nil {
				_ = os.Remove(lock)
				return errors.Join(werr, cerr)
			}
			defer os.Remove(lock)
			return fn()
		}
		if !os.IsExist(err) {
			return err
		}
		if st, serr := os.Stat(lock); serr == nil && time.Since(st.ModTime()) > 30*time.Second {
			var pid int
			if raw, rerr := os.ReadFile(lock); rerr == nil {
				_, _ = fmt.Sscanf(string(raw), "%d", &pid)
				if pid > 0 && !processAlive(pid) {
					_ = os.Remove(lock)
					continue
				}
			}
		}
		if time.Now().After(deadline) {
			return errors.New("native_terminal_registry_busy")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func readEntry(path string) (Entry, map[string]json.RawMessage, error) {
	raw, err := readRegistryFile(path)
	if err != nil {
		return Entry{}, nil, err
	}
	var entry Entry
	var document map[string]json.RawMessage
	if json.Unmarshal(raw, &entry) != nil || json.Unmarshal(raw, &document) != nil || document == nil {
		return Entry{}, nil, ErrInvalid
	}
	// Read old Go snake_case records too; all new writes remain Node-compatible.
	if entry.AccountRef == "" {
		_ = json.Unmarshal(document["account_ref"], &entry.AccountRef)
	}
	if entry.RuntimeScope == "" {
		_ = json.Unmarshal(document["runtime_scope"], &entry.RuntimeScope)
	}
	if len(entry.ForwardArgs) == 0 {
		_ = json.Unmarshal(document["forward_args"], &entry.ForwardArgs)
	}
	// Node's normalizer preserves the public contract but drops unknown owner
	// fields. Recover only missing lifecycle fields from our identity-matched
	// private sidecar, without replacing Node's updated nativeSessionId/resources.
	sidecar := filepath.Join(filepath.Dir(filepath.Dir(path)), "native-terminal-owners", filepath.Base(path))
	if saved, err := readRegistryFile(sidecar); err == nil {
		var owner Entry
		if json.Unmarshal(saved, &owner) == nil && matchingPrivateOwner(entry, owner) {
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(saved, &fields)
			for key, value := range fields {
				if _, exists := document[key]; !exists {
					document[key] = value
				}
			}
			merged, _ := json.Marshal(document)
			_ = json.Unmarshal(merged, &entry)
			entry.trustedOwner = true
		}
	}
	return entry, document, nil
}

// matchingPrivateOwner treats the public record as display metadata, not an
// authority to signal processes. Node may omit private fields when normalizing,
// but present identity/process fields may not disagree with the private owner.
func matchingPrivateOwner(public, private Entry) bool {
	if private.Owner != Owner || !validEntryAddress(private) ||
		public.Provider != private.Provider || public.AccountRef != private.AccountRef ||
		public.RuntimeScope != private.RuntimeScope || public.Socket != private.Socket ||
		public.Session != private.Session || public.CorrelationID != private.CorrelationID ||
		public.CWD != private.CWD {
		return false
	}
	if public.Owner != "" && public.Owner != private.Owner {
		return false
	}
	if public.IdentityProvider != "" && public.IdentityProvider != private.IdentityProvider {
		return false
	}
	if public.CLIAccountID != 0 && public.CLIAccountID != private.CLIAccountID {
		return false
	}
	if len(public.Args) > 0 && !slices.Equal(public.Args, private.Args) {
		return false
	}
	if public.SupervisorPID != 0 && public.SupervisorPID != private.SupervisorPID {
		return false
	}
	if public.Mux != "" && public.Mux != private.Mux {
		return false
	}
	if public.MuxSignature != "" && public.MuxSignature != private.MuxSignature {
		return false
	}
	// A public-only close flag cannot bypass a missing/partial private update.
	return public.CloseRequested == private.CloseRequested
}

// readTrustedEntry serializes against the two-file writer. A half-written create
// or update is never accepted as a destructive close authorization.
func readTrustedEntry(ctx context.Context, path string) (Entry, error) {
	var entry Entry
	err := withEntryLock(ctx, path, func() error {
		current, _, err := readEntry(path)
		if err != nil {
			return err
		}
		if !current.trustedOwner {
			return errors.New("native_terminal_registry_untrusted")
		}
		entry = current
		return nil
	})
	return entry, err
}

func readRegistryFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 2<<20 {
		return nil, ErrInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, 2<<20))
}
func validEntryAddress(entry Entry) bool {
	socket, err := persistent.DeriveSocket(entry.Provider, entry.AccountRef)
	return err == nil && entry.Socket == socket && entry.RuntimeScope == entry.AccountRef && safePart.MatchString(entry.Session) && safePart.MatchString(entry.CorrelationID)
}
func writePrivateAtomic(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".native-owner-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(content)
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func writeEntry(ctx context.Context, home string, entry Entry, create bool) error {
	if !validEntryAddress(entry) || entry.Owner != Owner {
		return ErrInvalid
	}
	path, err := entryPath(home, entry.Socket, entry.Session)
	if err != nil {
		return err
	}
	return withEntryLock(ctx, path, func() error {
		previous, doc, readErr := readEntry(path)
		if create && readErr == nil {
			return errors.New("native_terminal_session_exists")
		}
		if create {
			sidecar := filepath.Join(home, "run", "native-terminal-owners", filepath.Base(path))
			if _, sideErr := os.Lstat(sidecar); !os.IsNotExist(sideErr) {
				return errors.New("native_terminal_owner_record_exists")
			}
		}
		if !create && readErr != nil {
			return readErr
		}
		if !create && (!previous.trustedOwner || previous.Owner != Owner || previous.CorrelationID != entry.CorrelationID || previous.AccountRef != entry.AccountRef) {
			return ErrInvalid
		}
		if readErr != nil && !os.IsNotExist(readErr) {
			return readErr
		}
		if doc == nil {
			doc = map[string]json.RawMessage{}
		}
		if previous.CreatedAt > 0 {
			entry.CreatedAt = previous.CreatedAt
		}
		if entry.SupervisorPID == 0 {
			entry.SupervisorPID = previous.SupervisorPID
		}
		if entry.NativeSessionID == "" {
			entry.NativeSessionID = previous.NativeSessionID
		}
		entry.CloseRequested = entry.CloseRequested || previous.CloseRequested
		if entry.CreatedAt == 0 {
			entry.CreatedAt = time.Now().UnixMilli()
		}
		entry.UpdatedAt = time.Now().UnixMilli()
		encoded, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(encoded, &fields)
		for key, value := range fields {
			doc[key] = value
		}
		content, err := json.MarshalIndent(doc, "", "  ")
		if err != nil {
			return err
		}
		temp, err := os.CreateTemp(filepath.Dir(path), ".native-entry-")
		if err != nil {
			return err
		}
		name := temp.Name()
		defer os.Remove(name)
		if err = temp.Chmod(0600); err == nil {
			_, err = temp.Write(append(content, '\n'))
		}
		err = errors.Join(err, temp.Close())
		if err != nil {
			return err
		}
		if err = os.Rename(name, path); err != nil {
			return err
		}
		return writePrivateAtomic(filepath.Join(home, "run", "native-terminal-owners", filepath.Base(path)), append(encoded, '\n'))
	})
}

func removeEntry(ctx context.Context, home string, entry Entry) error {
	path, err := entryPath(home, entry.Socket, entry.Session)
	if err != nil {
		return err
	}
	return withEntryLock(ctx, path, func() error {
		current, _, err := readEntry(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if !current.trustedOwner || current.Owner != Owner || current.CorrelationID != entry.CorrelationID {
			return ErrInvalid
		}
		if err = os.Remove(path); err != nil {
			return err
		}
		ownerPath := filepath.Join(home, "run", "native-terminal-owners", filepath.Base(path))
		if err = os.Remove(ownerPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	})
}

// List returns only this implementation's entries; old Node records are untouched.
func List(home string) ([]Entry, error) {
	dir, err := registryDir(home)
	if err != nil {
		return nil, err
	}
	files, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Entry{}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, file.Name())
		var entry Entry
		err := withEntryLock(context.Background(), path, func() error {
			current, _, readErr := readEntry(path)
			sidecar := filepath.Join(home, "run", "native-terminal-owners", file.Name())
			_, sideErr := os.Lstat(sidecar)
			hasPrivate := !os.IsNotExist(sideErr)
			if readErr != nil {
				if hasPrivate {
					return errors.New("native_terminal_registry_untrusted")
				}
				return nil // Unknown legacy record: never claim its processes.
			}
			if current.Owner != Owner && !hasPrivate {
				return nil
			}
			if !current.trustedOwner || !validEntryAddress(current) || file.Name() != current.Socket+"--"+current.Session+".json" {
				return errors.New("native_terminal_registry_untrusted")
			}
			entry = current
			return nil
		})
		if err != nil {
			return nil, err
		}
		if entry.trustedOwner {
			out = append(out, entry)
		}
	}
	return out, nil
}

func writeEnvelope(home string, value launchEnvelope) (string, error) {
	id, err := token()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "run", "native-terminal-launches")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, id+".json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, err = file.Write(raw)
	err = errors.Join(err, file.Close())
	if err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return id, nil
}
func consumeEnvelope(home, id string) (launchEnvelope, error) {
	var value launchEnvelope
	if len(id) != 24 || !safePart.MatchString(id) {
		return value, ErrInvalid
	}
	path := filepath.Join(home, "run", "native-terminal-launches", id+".json")
	st, err := os.Lstat(path)
	if err != nil {
		return value, err
	}
	if !st.Mode().IsRegular() || st.Size() > 2<<20 {
		return value, ErrInvalid
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return value, err
	}
	if err = json.Unmarshal(raw, &value); err != nil {
		return value, err
	}
	if err = os.Remove(path); err != nil {
		return value, err
	}
	return value, nil
}
