package chatruntime

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
)

// DatabaseSession is a finite continuous same-host no-restore session. It is
// never minted from JSON/nonce/current row, never a restore-ABA proof, and never
// enabled by ordinary OpenDatabase. It proves only this Database+connection
// and original matching root writer-lease critical sections. Raw other writers
// and independently issued leases/populations are not excluded by this type.
type DatabaseSession struct {
	database   *Database
	conn       *sql.Conn
	guard      *accountwriterlease.Guard
	generation uint64
	closed     bool // original database.mu protects all fields
	closeErr   error
}

// CaptureDatabaseSession must be called by an already controlled external
// lifecycle, after its old users returned all rows/transactions. Capturing the
// pool's only connection makes ordinary pooled read/write explicitly refuse;
// it does not silently deadlock them or transparently pretend *sql.DB is Conn.
func (d *Database) CaptureDatabaseSession(ctx context.Context, holder *accountwriterlease.Lease) (*DatabaseSession, error) {
	if d == nil || ctx == nil || holder == nil {
		return nil, NewError("chat_database_session_source_required", 503, nil)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.reserved || d.sqlDB == nil {
		return nil, NewError("chat_database_session_unavailable", 409, nil)
	}
	if !filepath.IsAbs(d.path) || filepath.Clean(d.path) != d.path {
		return nil, NewError("chat_database_session_path_invalid", 409, nil)
	}
	guard, err := holder.Borrow(filepath.Dir(d.path))
	if err != nil {
		return nil, err
	}
	d.reserved = true // reserve under same mutex before acquiring ConnMax1 slot
	conn, err := d.sqlDB.Conn(ctx)
	if err != nil {
		d.reserved = false
		return nil, errors.Join(err, guard.Close())
	}
	var session *DatabaseSession
	err = guard.Do(func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		d.generation++
		session = &DatabaseSession{database: d, conn: conn, guard: guard, generation: d.generation}
		d.session = session // publication and final original-holder check coincide
		return nil
	})
	if err != nil {
		closeErr := conn.Close()
		guardErr := guard.Close()
		if closeErr == nil && guardErr == nil {
			d.reserved = false
		} else {
			d.closed = true
			d.generation++
			d.closeErr = errors.Join(closeErr, guardErr)
			// A failed unpublished capture still retains the exact resources
			// whose closure is uncertain; do not lose them to local variables.
			d.session = &DatabaseSession{database: d, conn: conn, guard: guard, closed: true, closeErr: d.closeErr}
		}
		return nil, errors.Join(err, closeErr, guardErr)
	}
	return session, nil
}

func (session *DatabaseSession) withConnection(ctx context.Context, fn func(*sql.Conn) error) error {
	if session == nil || session.database == nil || ctx == nil || fn == nil {
		return NewError("chat_database_session_required", 503, nil)
	}
	d := session.database
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || session.closed || d.session != session || d.generation != session.generation || session.conn == nil {
		return NewError("chat_database_session_stale", 409, nil)
	}
	return session.guard.Do(func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return fn(session.conn)
	})
}

// WithRead runs on the actual retained connection. The callback owns all rows
// it opens and must close them before returning; no nested session/pool/lifecycle
// calls or escaped goroutine may retain this resource or its authority.
func (session *DatabaseSession) WithRead(ctx context.Context, fn func(*sql.Conn) error) error {
	return session.withConnection(ctx, fn)
}

func (session *DatabaseSession) WithTx(ctx context.Context, fn func(*sql.Tx) error) error {
	if fn == nil {
		return NewError("chat_database_session_callback_required", 503, nil)
	}
	return session.withConnection(ctx, func(conn *sql.Conn) (resultErr error) {
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				resultErr = errors.Join(resultErr, tx.Rollback())
			}
		}()
		if err := fn(tx); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		committed = true
		return nil
	})
}

func (session *DatabaseSession) closeLocked() error {
	if session.closed {
		return session.closeErr
	}
	session.closed = true
	d := session.database
	d.generation++
	if session.conn != nil {
		session.closeErr = session.conn.Close()
		if session.closeErr != nil {
			return session.closeErr
		} // retain guard/root on uncertainty
		session.conn = nil
	}
	session.closeErr = session.guard.Close()
	return session.closeErr
}

// Close invalidates the captured generation permanently. It does not silently
// reopen ordinary pool admission or release the original external writer lease.
func (session *DatabaseSession) Close() error {
	if session == nil || session.database == nil {
		return nil
	}
	d := session.database
	d.mu.Lock()
	defer d.mu.Unlock()
	return session.closeLocked()
}
