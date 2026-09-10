"""SQLite connection and transaction policy for new ERP services."""

from contextlib import contextmanager
import sqlite3


def connect(database_path, readonly=False):
    if readonly:
        conn = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True, timeout=30)
    else:
        conn = sqlite3.connect(database_path, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


@contextmanager
def write_transaction(conn):
    if conn.in_transaction:
        raise RuntimeError("La transaccion ERP debe comenzar en el limite del servicio.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    else:
        conn.commit()
