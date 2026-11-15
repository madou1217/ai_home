package remotebackup

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/oauthaccount"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
)

type profileExporter interface {
	GetProfile(context.Context, accountcore.AccountRef) (accountapp.ProfileSnapshot, error)
}

func portableClaude(ctx context.Context, store ExportStore, ref accountcore.AccountRef, auth *claude.OAuthAuth) (map[string]any, int64, bool) {
	source, ok := store.(profileExporter)
	if !ok {
		return nil, 0, false
	}
	snap, err := source.GetProfile(ctx, ref)
	if err != nil {
		return nil, 0, false
	}
	profile, ok := snap.Profile().(claude.AccountProfile)
	if !ok {
		return nil, 0, false
	}
	credentials, err := securestorage.Encode(securestorage.DecodedOAuth{Auth: auth, Subscription: profile.Subscription()})
	if err != nil {
		return nil, 0, false
	}
	config, err := oauthaccount.Encode(profile.OAuthProfile())
	if err != nil {
		return nil, 0, false
	}
	a, err := decodePortableJSON(credentials)
	if err != nil {
		return nil, 0, false
	}
	b, err := decodePortableJSON(config)
	if err != nil {
		return nil, 0, false
	}
	return map[string]any{"credentials": a, "config": b}, snap.UpdatedAt().UnixMilli(), true
}
func decodePortableJSON(raw []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, io.ErrUnexpectedEOF
	}
	return value, nil
}
