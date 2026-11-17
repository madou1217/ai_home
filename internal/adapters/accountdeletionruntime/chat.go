package accountdeletionruntime

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// ChatOwner resolves the shared service lazily because chat handlers are wired
// after the account application services, before the host begins listening.
type ChatOwner struct{ Service func() *chatruntime.Service }

func (o ChatOwner) Inspect(ctx context.Context, a accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	if o.Service == nil || o.Service() == nil {
		return nil, nil
	}
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return nil, accountapp.ErrAccountRuntimeUnverifiable
	}
	if state.chatObserved == nil {
		state.chatObserved = map[string]chatruntime.AccountRunObservation{}
	}
	observations, err := o.Service().ObserveAccountRunsForDeletion(ctx, a.ProviderID(), a.Ref().String())
	if err != nil {
		return nil, err
	}
	for _, observation := range observations {
		if prior, exists := state.chatObserved[observation.Run.RunID]; exists && prior.Quiesced != observation.Quiesced {
			return nil, accountapp.ErrAccountRuntimeUnverifiable
		}
		state.chatObserved[observation.Run.RunID] = observation
	}
	out := []accountapp.DeletionBlocker{}
	active := map[string]bool{}
	for _, observation := range observations {
		active[observation.Run.RunID] = true
	}
	for id, observation := range state.chatObserved {
		if observation.Quiesced != nil {
			select {
			case <-observation.Quiesced:
				if observation.CleanupError == nil {
					return nil, accountapp.ErrAccountRuntimeUnverifiable
				}
				if err := observation.CleanupError(); err != nil {
					return nil, errors.Join(accountapp.ErrAccountDeletionPreparationFailed, err)
				}
				if !active[id] {
					continue
				}
			default:
			}
		} else if !active[id] {
			continue
		}
		run := observation.Run
		out = append(out, accountapp.DeletionBlocker{Kind: "native_session", Label: "运行中的会话", Provider: a.ProviderID(), AccountRef: a.Ref().String(), Session: run.SessionID, Detail: run.RunID})
	}
	return out, nil
}
func (o ChatOwner) Release(ctx context.Context, a accountcore.Account) error {
	if o.Service == nil || o.Service() == nil {
		return nil
	}
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return accountapp.ErrAccountRuntimeUnverifiable
	}
	if err := o.Service().AbortAccountRuns(ctx, a.ProviderID(), a.Ref().String()); err != nil {
		return err
	}
	for _, observation := range state.chatObserved {
		if observation.Quiesced == nil {
			continue
		}
		select {
		case <-observation.Quiesced:
		case <-ctx.Done():
			return ctx.Err()
		}
		if observation.CleanupError == nil {
			return accountapp.ErrAccountRuntimeUnverifiable
		}
		if err := observation.CleanupError(); err != nil {
			return errors.Join(accountapp.ErrAccountDeletionPreparationFailed, err)
		}
	}
	return nil
}
func (o ChatOwner) Prepare(context.Context, accountcore.Account) error      { return nil }
func (o ChatOwner) Finish(context.Context, accountcore.Account, bool) error { return nil }
