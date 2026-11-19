package remotebackup

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/contracts/backuprepository"
)

// RemoteSnapshot 是远端仓库的可恢复快照。
type RemoteSnapshot struct {
	Manifest RepositoryManifest
	Accounts []AccountRecord
	Missing  []string
	Corrupt  map[string]string
	Bytes    int
	Revision int
}

// ReadRemoteSnapshot 读取远端 manifest 与全部对象，并校验对象摘要。
func ReadRemoteSnapshot(ctx context.Context, strategy Strategy) (RemoteSnapshot, error) {
	layout := backuprepository.Contract
	raw, found, err := strategy.ReadFile(ctx, layout.ManifestPath)
	if err != nil {
		return RemoteSnapshot{}, err
	}
	if !found {
		return RemoteSnapshot{}, errors.New("backup_manifest_missing")
	}
	manifest, err := parseRepositoryManifest([]byte(raw))
	if err != nil {
		return RemoteSnapshot{}, err
	}
	snapshot := RemoteSnapshot{
		Manifest: *manifest,
		Missing:  []string{},
		Corrupt:  map[string]string{},
		Bytes:    len(raw),
		Revision: manifest.Revision,
	}
	for ref, entry := range manifest.Accounts {
		if entry.Deleted && entry.ObjectSHA256 == "" {
			continue
		}
		objectFile, pathErr := objectPath(entry.ObjectSHA256)
		if pathErr != nil {
			snapshot.Corrupt[ref] = pathErr.Error()
			continue
		}
		content, present, readErr := strategy.ReadFile(ctx, objectFile)
		if readErr != nil {
			snapshot.Corrupt[ref] = strings.TrimSpace(readErr.Error())
			continue
		}
		if !present {
			snapshot.Missing = append(snapshot.Missing, ref)
			continue
		}
		record, verifyErr := verifyRepositoryObject([]byte(content), ref, entry)
		if verifyErr != nil {
			snapshot.Corrupt[ref] = verifyErr.Error()
			continue
		}
		snapshot.Accounts = append(snapshot.Accounts, record)
	}
	return snapshot, nil
}
