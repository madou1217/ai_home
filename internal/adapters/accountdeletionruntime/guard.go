// Package accountdeletionruntime composes the actual runtime owners around the
// shared account deletion use case. HTTP aliases do not own cleanup semantics.
package accountdeletionruntime

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/accountadmission"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

type Deletion interface {
	DeleteAccountWithOptions(context.Context, accountcore.AccountRef, accountapp.DeletionOptions) (accountapp.DeletionOutcome, error)
}

type Guard struct {
	AIHomeDir   string
	occupancy   accountapp.DeletionOccupancy
	preparation accountapp.DeletionPreparation
	owners      []Owner
	deletion    Deletion
	locks       sync.Map
}

// Owner exposes only the runtime facts and close operations that its actual
// process owns. Inspect is read-only; Release is called only after force=true.
type Owner interface {
	Inspect(context.Context, accountcore.Account) ([]accountapp.DeletionBlocker, error)
	Release(context.Context, accountcore.Account) error
	Prepare(context.Context, accountcore.Account) error
	Finish(context.Context, accountcore.Account, bool) error
}

type requestState struct {
	account      accountcore.Account
	nodeLease    string
	hostTargets  []hostProcess
	chatObserved map[string]chatruntime.AccountRunObservation
	intent       *accountadmission.Lease
	quiesced     *accountadmission.Lease
}
type stateKey struct{}

func New(occupancy accountapp.DeletionOccupancy, preparation accountapp.DeletionPreparation, owners ...Owner) (*Guard, error) {
	if occupancy == nil || preparation == nil {
		return nil, accountapp.ErrInvalidDeletionDependencies
	}
	for _, owner := range owners {
		if owner == nil {
			return nil, accountapp.ErrInvalidDeletionDependencies
		}
	}
	return &Guard{occupancy: occupancy, preparation: preparation, owners: append([]Owner(nil), owners...)}, nil
}

func (g *Guard) Bind(deletion Deletion) { g.deletion = deletion }

func (g *Guard) DeleteAccount(ctx context.Context, ref accountcore.AccountRef) error {
	_, err := g.DeleteAccountWithOptions(ctx, ref, accountapp.DeletionOptions{})
	return err
}

func (g *Guard) DeleteAccountWithOptions(ctx context.Context, ref accountcore.AccountRef, options accountapp.DeletionOptions) (accountapp.DeletionOutcome, error) {
	if g == nil || g.deletion == nil || ctx == nil || !ref.IsValid() {
		return accountapp.DeletionOutcome{}, accountapp.ErrInvalidDeletionRequest
	}
	lock, _ := g.locks.LoadOrStore(ref.String(), &sync.Mutex{})
	mutex := lock.(*sync.Mutex)
	mutex.Lock()
	defer mutex.Unlock()
	op, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	ctx = op
	state := &requestState{}
	defer func() {
		if state.quiesced != nil {
			_ = state.quiesced.Close()
		}
		if state.intent != nil {
			_ = state.intent.Close()
		}
	}()
	ctx = context.WithValue(ctx, stateKey{}, state)
	outcome, err := g.deletion.DeleteAccountWithOptions(ctx, ref, options)
	if state.account.IsValid() {
		for i := len(g.owners) - 1; i >= 0; i-- {
			// Finishing a lease must still run after request cancellation. It never
			// signals user processes and must not overwrite a committed deletion.
			_ = g.owners[i].Finish(context.WithoutCancel(ctx), state.account, err == nil)
		}
	}
	return outcome, err
}

func (g *Guard) InspectAccountDeletion(ctx context.Context, account accountcore.Account) ([]accountapp.DeletionBlocker, error) {
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return nil, accountapp.ErrAccountRuntimeUnverifiable
	}
	state.account = account
	if state.intent == nil {
		lease, err := accountadmission.Deleting(g.AIHomeDir, account.ProviderID(), account.Ref().String())
		if err != nil {
			if errors.Is(err, accountadmission.ErrBusy) {
				return nil, errors.Join(accountapp.ErrAccountRuntimeActive, err)
			}
			return nil, errors.Join(accountapp.ErrAccountRuntimeUnverifiable, err)
		}
		state.intent = lease
	}
	var blockers []accountapp.DeletionBlocker
	for _, owner := range g.owners {
		found, err := owner.Inspect(ctx, account)
		if err != nil {
			log.Printf("账号删除运行状态无法确认 provider=%s account=%s owner=%T cause=%v", account.ProviderID(), account.Ref(), owner, err)
			return nil, errors.Join(accountapp.ErrAccountRuntimeUnverifiable, err)
		}
		for _, blocker := range found {
			if blocker.Uncertain {
				return nil, accountapp.ErrAccountRuntimeUnverifiable
			}
		}
		blockers = append(blockers, found...)
	}
	found, err := g.occupancy.InspectAccountDeletion(ctx, account)
	if err != nil {
		return nil, err
	}
	for _, blocker := range found {
		if blocker.Uncertain {
			return nil, accountapp.ErrAccountRuntimeUnverifiable
		}
	}
	return append(blockers, found...), nil
}

func (g *Guard) ReleaseAccountDeletion(ctx context.Context, account accountcore.Account, _ []accountapp.DeletionBlocker) error {
	// Never trust a caller-supplied PID or blocker. Every owner re-reads its own
	// handles for the validated account before it attempts any close operation.
	for _, owner := range g.owners {
		if err := owner.Release(ctx, account); err != nil {
			return err
		}
	}
	remaining, err := g.occupancy.InspectAccountDeletion(ctx, account)
	if err != nil {
		return err
	}
	if len(remaining) > 0 {
		if err := g.occupancy.ReleaseAccountDeletion(ctx, account, remaining); err != nil {
			return err
		}
	}
	blockers, err := g.InspectAccountDeletion(ctx, account)
	if err != nil {
		return err
	}
	if len(blockers) > 0 {
		return &accountapp.RuntimeActiveError{Blockers: blockers}
	}
	return nil
}

func (g *Guard) PrepareAccountDeletion(ctx context.Context, account accountcore.Account) error {
	blockers, err := g.InspectAccountDeletion(ctx, account)
	if err != nil {
		return err
	}
	if len(blockers) > 0 {
		return &accountapp.RuntimeActiveError{Blockers: blockers}
	}
	for _, owner := range g.owners {
		if err := owner.Prepare(ctx, account); err != nil {
			return err
		}
	}
	state, _ := ctx.Value(stateKey{}).(*requestState)
	if state == nil {
		return accountapp.ErrAccountRuntimeUnverifiable
	}
	if state.quiesced == nil {
		lease, err := accountadmission.Quiesced(g.AIHomeDir, account.ProviderID(), account.Ref().String())
		if err != nil {
			return errors.Join(accountapp.ErrAccountRuntimeActive, err)
		}
		state.quiesced = lease
	}
	return g.preparation.PrepareAccountDeletion(ctx, account)
}
