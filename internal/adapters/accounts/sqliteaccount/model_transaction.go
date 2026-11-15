package sqliteaccount

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"modernc.org/sqlite"
)

const modelWriteAdmissionBudget = 2 * time.Second

// modelTransaction retains routingWrites through post-commit publication. Its
// admission may retry BEGIN only; no model mutation, commit or upstream request
// is ever replayed. A connection-local busy=0 makes the context budget reliable.
type modelTransaction struct {
	*sql.Conn
	store       *Store
	busyTimeout int
	committed   bool
	closed      bool
}

func (store *Store) beginModelTransaction(ctx context.Context) (*modelTransaction, error) {
	if ctx == nil {
		return nil, accountapp.ErrInvalidAccountModel
	}
	admission, cancel := context.WithTimeout(ctx, modelWriteAdmissionBudget)
	defer cancel()
	for !store.routingWrites.TryLock() {
		if err := waitModelWriter(admission, 25*time.Millisecond); err != nil {
			return nil, modelAdmissionError(ctx)
		}
	}
	locked := true
	defer func() {
		if locked {
			store.routingWrites.Unlock()
		}
	}()
	conn, err := store.db.Conn(admission)
	if err != nil {
		if admission.Err() != nil {
			return nil, modelAdmissionError(ctx)
		}
		return nil, err
	}
	transaction := &modelTransaction{Conn: conn, store: store}
	locked = false // rollback owns both connection cleanup and the in-process lock.
	success := false
	defer func() {
		if !success {
			_ = transaction.Rollback()
		}
	}()
	if err := conn.QueryRowContext(admission, "PRAGMA busy_timeout").Scan(&transaction.busyTimeout); err != nil {
		if admission.Err() != nil {
			return nil, modelAdmissionError(ctx)
		}
		return nil, err
	}
	if _, err := conn.ExecContext(admission, "PRAGMA busy_timeout=0"); err != nil {
		if admission.Err() != nil {
			return nil, modelAdmissionError(ctx)
		}
		return nil, err
	}
	delay := 25 * time.Millisecond
	for {
		if admission.Err() != nil {
			return nil, modelAdmissionError(ctx)
		}
		_, err = conn.ExecContext(admission, "BEGIN IMMEDIATE")
		if err == nil {
			break
		}
		if admission.Err() != nil {
			return nil, modelAdmissionError(ctx)
		}
		if !isModelWriterBusy(err) {
			return nil, err
		}
		if err = waitModelWriter(admission, delay); err != nil {
			return nil, modelAdmissionError(ctx)
		}
		if delay < 200*time.Millisecond {
			delay *= 2
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	success = true
	return transaction, nil
}

func waitModelWriter(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func modelAdmissionError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return accountapp.ErrModelWriteBusy
}
func isModelWriterBusy(err error) bool {
	var sqliteErr *sqlite.Error
	return errors.As(err, &sqliteErr) && (sqliteErr.Code()&0xff == 5 || sqliteErr.Code()&0xff == 6)
}

func (transaction *modelTransaction) Commit(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Once finalization starts, match sql.Tx.Commit's cancellation boundary:
	// do not report a canceled context after SQLite has already committed. The
	// caller must publish this committed snapshot while routingWrites is held.
	if _, err := transaction.Conn.ExecContext(context.WithoutCancel(ctx), "COMMIT"); err != nil {
		return err
	}
	transaction.committed = true
	return nil
}

// Rollback also releases a successfully committed transaction after route
// publication. Failed cleanup discards the connection rather than pooling a
// live transaction or a modified busy timeout. It never undoes a committed DB.
func (transaction *modelTransaction) Rollback() error {
	if transaction.closed {
		return nil
	}
	transaction.closed = true
	defer transaction.store.routingWrites.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var rollbackErr error
	if !transaction.committed {
		_, rollbackErr = transaction.Conn.ExecContext(ctx, "ROLLBACK")
		// BEGIN may never have succeeded. A no-transaction rollback error is also
		// grounds to discard, not to inspect/string-match a provider error message.
	}
	_, resetErr := transaction.Conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", transaction.busyTimeout))
	if rollbackErr != nil || resetErr != nil {
		_ = transaction.Conn.Raw(func(any) error { return driver.ErrBadConn })
	}
	closeErr := transaction.Conn.Close()
	return errors.Join(rollbackErr, resetErr, closeErr)
}
