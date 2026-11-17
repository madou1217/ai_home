package distributiondata

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"modernc.org/sqlite"
)

func openDB(ctx context.Context, path string, readOnly bool) (*sql.DB, error) {
	u := sqlitefile.URL(path)
	q := u.Query()
	q.Set("mode", "rw")
	if readOnly {
		q.Set("mode", "ro")
	}
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return db, nil
}

// snapshot is only called on private files. Backup API incorporates committed
// WAL pages into a consistent database; copying the main file alone cannot.
func snapshot(ctx context.Context, source, target string) (resultErr error) {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	db, err := openDB(ctx, source, false)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, conn.Close()) }()
	if err := conn.Raw(func(raw any) (err error) {
		backupper, ok := raw.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		})
		if !ok {
			return errors.New("distributiondata: SQLite Backup API is unavailable")
		}
		backup, err := backupper.NewBackup(sqlitefile.URL(target).String())
		if err != nil {
			return err
		}
		defer func() { err = errors.Join(err, backup.Finish()) }()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			more, err := backup.Step(256)
			if err != nil || !more {
				return err
			}
		}
	}); err != nil {
		return fmt.Errorf("distributiondata: SQLite backup: %w", err)
	}
	return standalone(ctx, target)
}

// standalone checkpoints only private artifacts and makes them safe to publish
// as individual files, without losing committed pages in an omitted WAL.
func standalone(ctx context.Context, path string) (resultErr error) {
	db, err := openDB(ctx, path, false)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=DELETE").Scan(&mode); err != nil {
		return err
	}
	if mode != "delete" {
		return errors.New("distributiondata: private database would require sidecars")
	}
	if err := integrity(ctx, db); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, file.Close()) }()
	return file.Sync()
}

func integrity(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return err
	}
	ok, count := true, 0
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			rows.Close()
			return err
		}
		count++
		ok = ok && value == "ok"
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	if !ok || count != 1 {
		return errors.New("distributiondata: integrity_check_failed")
	}
	rows, err = db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("distributiondata: foreign_key_check_failed")
	}
	return rows.Err()
}

// A copied hot rollback journal may reference an absolute SQLite super-journal.
// Refuse that interrupted multi-DB transaction, rather than letting recovery of
// a private copy follow and potentially unlink a live super-journal. Ordinary
// rollback journals and WAL are recovered entirely inside the private capture.
func checkJournal(path string) (resultErr error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, f.Close()) }()
	info, err := f.Stat()
	if err != nil || info.Size() < 16 {
		return err
	}
	var tail [8]byte
	if _, err := f.ReadAt(tail[:], info.Size()-8); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if bytes.Equal(tail[:], []byte{0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7}) {
		return errors.New("distributiondata: interrupted_multi_database_transaction; automatic rollback must precede retry")
	}
	return nil
}
