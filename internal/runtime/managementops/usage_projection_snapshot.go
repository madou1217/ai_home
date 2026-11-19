package managementops

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"time"
)

const projectionReadSavepointName = "mup_proj_read_snap"

type projectionReadSnapshot struct {
	conn      *sql.Conn
	begun     bool
	savepoint string
}

func isWithinTransactionError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "within a transaction")
}

func discardUncertainConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
}

// beginProjectionReadSnapshot opens a strict DEFERRED read transaction on a
// freshly checked-out pooled *sql.Conn. It does not swallow within-transaction
// errors, rolls back if ExecContext returns a driver cancellation override
// after starting the transaction, and discards uncertain connections via driver.ErrBadConn.
func beginProjectionReadSnapshot(ctx context.Context, conn *sql.Conn) (projectionReadSnapshot, error) {
	if conn == nil {
		return projectionReadSnapshot{}, errors.New("projection_conn_nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return projectionReadSnapshot{}, err
	}
	if _, err := conn.ExecContext(ctx, `BEGIN DEFERRED`); err != nil {
		if isWithinTransactionError(err) {
			discardUncertainConn(conn)
			return projectionReadSnapshot{}, err
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, rbErr := conn.ExecContext(cleanupCtx, `ROLLBACK`)
		cancel()
		if rbErr != nil {
			discardUncertainConn(conn)
		}
		return projectionReadSnapshot{}, err
	}
	return projectionReadSnapshot{conn: conn, begun: true}, nil
}

// beginProjectionReadSavepoint isolates a read snapshot on a caller-supplied
// *sql.Conn using SAVEPOINT so any active outer transaction is preserved safely.
func beginProjectionReadSavepoint(ctx context.Context, conn *sql.Conn) (projectionReadSnapshot, error) {
	if conn == nil {
		return projectionReadSnapshot{}, errors.New("projection_conn_nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return projectionReadSnapshot{}, err
	}
	if _, err := conn.ExecContext(ctx, `SAVEPOINT `+projectionReadSavepointName); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, rbErr := conn.ExecContext(cleanupCtx, `ROLLBACK TO SAVEPOINT `+projectionReadSavepointName)
		if rbErr == nil {
			if _, relErr := conn.ExecContext(cleanupCtx, `RELEASE SAVEPOINT `+projectionReadSavepointName); relErr != nil {
				discardUncertainConn(conn)
			}
		} else {
			discardUncertainConn(conn)
		}
		cancel()
		return projectionReadSnapshot{}, err
	}
	return projectionReadSnapshot{
		conn:      conn,
		begun:     true,
		savepoint: projectionReadSavepointName,
	}, nil
}

func (s projectionReadSnapshot) close() {
	if !s.begun || s.conn == nil {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if s.savepoint != "" {
		if _, rbErr := s.conn.ExecContext(cleanupCtx, `ROLLBACK TO SAVEPOINT `+s.savepoint); rbErr != nil {
			discardUncertainConn(s.conn)
			return
		}
		if _, relErr := s.conn.ExecContext(cleanupCtx, `RELEASE SAVEPOINT `+s.savepoint); relErr != nil {
			discardUncertainConn(s.conn)
		}
		return
	}
	if _, err := s.conn.ExecContext(cleanupCtx, `ROLLBACK`); err != nil {
		discardUncertainConn(s.conn)
	}
}
