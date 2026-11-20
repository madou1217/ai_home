package accountbrowser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
)

const (
	runDirName              = "run"
	accountBrowserDirName   = "account-browser"
	profilesDirName         = "profiles"
	dataDirName             = "data"
	metadataFileName        = "profile.json"
	privateDirPerm          = os.FileMode(0o700)
	privateFilePerm         = os.FileMode(0o600)
	concurrentPublishWindow = 500 * time.Millisecond
)

type profileStore struct {
	aiHomeDir string
}

func (st *profileStore) openProfilesRoot(create bool) (*os.Root, error) {
	homeRoot, err := openTrustedHomeRoot(st.aiHomeDir, create)
	if err != nil {
		return nil, err
	}
	defer homeRoot.Close()

	// run/ is shared across AIH subsystems; never mutate its permissions or
	// reject valid shared directory modes, but always reject symlinks/non-dirs.
	runRoot, _, err := openVerifiedSubdir(homeRoot, runDirName, create, false)
	if err != nil {
		return nil, err
	}
	defer runRoot.Close()

	browserRoot, _, err := openVerifiedSubdir(runRoot, accountBrowserDirName, create, true)
	if err != nil {
		return nil, err
	}
	defer browserRoot.Close()

	profilesRoot, _, err := openVerifiedSubdir(browserRoot, profilesDirName, create, true)
	if err != nil {
		return nil, err
	}
	return profilesRoot, nil
}

func (st *profileStore) get(ctx context.Context, identity Identity) (Profile, error) {
	if err := ctx.Err(); err != nil {
		return Profile{}, err
	}
	profileID := deriveProfileID(identity)

	profilesRoot, err := st.openProfilesRoot(false)
	if err != nil {
		return Profile{}, err
	}
	defer profilesRoot.Close()

	profileRoot, _, err := openVerifiedSubdir(profilesRoot, profileID, false, true)
	if err != nil {
		return Profile{}, err
	}
	defer profileRoot.Close()

	profile, _, err := st.readExistingProfile(ctx, profileRoot, identity, profileID)
	if err != nil {
		return Profile{}, err
	}
	return profile, nil
}

func (st *profileStore) ensure(ctx context.Context, identity Identity) (Profile, string, bool, error) {
	if err := ctx.Err(); err != nil {
		return Profile{}, "", false, err
	}
	profileID := deriveProfileID(identity)

	profilesRoot, err := st.openProfilesRoot(true)
	if err != nil {
		return Profile{}, "", false, err
	}
	defer profilesRoot.Close()

	profileRoot, createdDir, err := openVerifiedSubdir(profilesRoot, profileID, true, true)
	if err != nil {
		return Profile{}, "", false, err
	}
	defer profileRoot.Close()

	if createdDir {
		return st.initializeNewProfile(ctx, profileRoot, identity, profileID)
	}
	return st.resolveExistingProfile(ctx, profileRoot, identity, profileID)
}

func (st *profileStore) initializeNewProfile(
	ctx context.Context,
	profileRoot *os.Root,
	identity Identity,
	profileID string,
) (Profile, string, bool, error) {
	if err := ctx.Err(); err != nil {
		return Profile{}, "", false, err
	}
	// Create data/ BEFORE publishing profile.json so any concurrent observer
	// that sees profile.json also sees a ready, validated private data dir.
	dataInfo, err := ensurePrivateDataDir(profileRoot)
	if err != nil {
		return Profile{}, "", false, err
	}

	now := time.Now().UnixMilli()
	if now <= 0 || now > maxTimestampMillis {
		return Profile{}, "", false, fmt.Errorf("system clock out of bounds: %w", ErrProfileCorrupt)
	}
	meta := profileMetadata{
		SchemaVersion: profileSchemaVersion,
		ID:            profileID,
		ServerID:      identity.ServerID,
		Provider:      identity.Provider,
		AccountRef:    identity.AccountRef,
		CreatedAt:     now,
	}
	payload, err := json.Marshal(meta)
	if err != nil {
		return Profile{}, "", false, fmt.Errorf("marshal profile metadata: %w", err)
	}
	payload = append(payload, '\n')

	tmpName, err := randomTempMetadataName()
	if err != nil {
		return Profile{}, "", false, err
	}
	tmpFile, err := profileRoot.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, privateFilePerm)
	if err != nil {
		return Profile{}, "", false, fmt.Errorf("create temp metadata: %w", err)
	}
	defer func() { _ = profileRoot.Remove(tmpName) }()

	if _, err := tmpFile.Write(payload); err != nil {
		_ = tmpFile.Close()
		return Profile{}, "", false, fmt.Errorf("write temp metadata: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		return Profile{}, "", false, fmt.Errorf("sync temp metadata: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return Profile{}, "", false, fmt.Errorf("close temp metadata: %w", err)
	}

	// Atomic no-clobber publish: Link fails with ErrExist if another writer
	// already published profile.json.
	if err := profileRoot.Link(tmpName, metadataFileName); err != nil {
		if errors.Is(err, os.ErrExist) {
			profile, winnerDataInfo, readErr := st.readExistingProfile(ctx, profileRoot, identity, profileID)
			if readErr != nil {
				return Profile{}, "", false, readErr
			}
			dataDir, pathErr := st.verifiedAbsoluteDataDir(profileID, winnerDataInfo)
			if pathErr != nil {
				return Profile{}, "", false, pathErr
			}
			return profile, dataDir, false, nil
		}
		return Profile{}, "", false, fmt.Errorf("publish profile metadata: %w", err)
	}

	syncRootDir(profileRoot)

	dataDir, err := st.verifiedAbsoluteDataDir(profileID, dataInfo)
	if err != nil {
		return Profile{}, "", false, err
	}
	return Profile{
		ID:         meta.ID,
		ServerID:   meta.ServerID,
		Provider:   meta.Provider,
		AccountRef: meta.AccountRef,
		CreatedAt:  meta.CreatedAt,
	}, dataDir, true, nil
}

// resolveExistingProfile handles both already-populated profiles and the brief
// cross-process race where a winner has created <profileID>/ but has not yet
// linked profile.json. Interrupted/corrupt directories still fail closed after
// the bounded wait window.
func (st *profileStore) resolveExistingProfile(
	ctx context.Context,
	profileRoot *os.Root,
	identity Identity,
	profileID string,
) (Profile, string, bool, error) {
	deadline := time.Now().Add(concurrentPublishWindow)
	delay := 2 * time.Millisecond

	for {
		if err := ctx.Err(); err != nil {
			return Profile{}, "", false, err
		}

		profile, dataInfo, metaMissing, err := st.tryReadExistingProfile(ctx, profileRoot, identity, profileID)
		if err == nil {
			dataDir, pathErr := st.verifiedAbsoluteDataDir(profileID, dataInfo)
			if pathErr != nil {
				return Profile{}, "", false, pathErr
			}
			return profile, dataDir, false, nil
		}
		if !metaMissing {
			return Profile{}, "", false, err
		}

		remaining := time.Until(deadline)
		if remaining <= 0 {
			return Profile{}, "", false, fmt.Errorf("profile directory missing metadata: %w", ErrProfileCorrupt)
		}
		wait := delay
		if wait > remaining {
			wait = remaining
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return Profile{}, "", false, ctx.Err()
		case <-timer.C:
		}
		if delay < 25*time.Millisecond {
			delay *= 2
		}
	}
}

func (st *profileStore) readExistingProfile(
	ctx context.Context,
	profileRoot *os.Root,
	identity Identity,
	profileID string,
) (Profile, fs.FileInfo, error) {
	profile, dataInfo, metaMissing, err := st.tryReadExistingProfile(ctx, profileRoot, identity, profileID)
	if err != nil {
		if metaMissing {
			return Profile{}, nil, fmt.Errorf("profile directory missing metadata: %w", ErrProfileCorrupt)
		}
		return Profile{}, nil, err
	}
	return profile, dataInfo, nil
}
