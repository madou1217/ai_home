package webuimodelsyncapi

import (
	"context"
	"errors"
	"fmt"
	"sync"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// refreshAllAccounts retains per-account failures even when an older catalog can
// still be read. Reading cached facts is not evidence that a probe succeeded.
func (handler *Handler) refreshAllAccounts(ctx context.Context) error {
	overviews, err := listAllAccountOverviews(ctx, handler.store)
	if err != nil {
		return err
	}
	_, providerSet := resolveModelCatalogProviders(handler.catalog)
	var refs []accountcore.AccountRef
	for _, overview := range overviews {
		if providerSet[overview.Account().ProviderID()] {
			refs = append(refs, overview.Account().Ref())
		}
	}
	if len(refs) == 0 {
		return nil
	}

	// Each worker owns one slot, so completion order cannot race or change the
	// first reported failure. The account coordinator still owns provider retries.
	failures := make([]error, len(refs))
	var workers sync.WaitGroup
	semaphore := make(chan struct{}, defaultRefreshWorkers)
launch:
	for index, ref := range refs {
		if ctx.Err() != nil {
			break
		}
		select {
		case semaphore <- struct{}{}:
		case <-ctx.Done():
			break launch
		}
		workers.Add(1)
		go func(index int, target accountcore.AccountRef) {
			defer func() {
				<-semaphore
				workers.Done()
			}()
			if _, err := handler.modelRefresher.RefreshAccountModels(ctx, target); err != nil {
				failures[index] = fmt.Errorf("账号 %s 模型探测失败: %w", target, err)
			}
		}(index, ref)
	}
	workers.Wait()

	failed := 0
	for _, err := range failures {
		if err != nil {
			failed++
		}
	}
	combined := errors.Join(failures...)
	if err := ctx.Err(); err != nil {
		combined = errors.Join(combined, err)
	}
	if combined != nil {
		return fmt.Errorf("模型刷新未完成（失败 %d/%d 个账号）: %w", failed, len(refs), combined)
	}
	return nil
}
