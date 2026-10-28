#!/usr/bin/env python3
"""SQLite operations use the standard backup API, including committed WAL data."""
import json
import sqlite3
import sys
from pathlib import Path

command, source, *args = sys.argv[1:]
connection = sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)
try:
    if command == 'status':
        version, dirty = connection.execute('SELECT version, dirty FROM schema_migrations').fetchone()
        required = {'users', 'tenants', 'knowledge_bases', 'models'}
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        print(json.dumps({'ready': not dirty and version == int(args[0]) and required <= tables,
                          'migrationVersion': version, 'dirty': bool(dirty)}))
    elif command == 'backup':
        destination = Path(args[0])
        destination.unlink(missing_ok=True)
        with sqlite3.connect(destination) as target:
            connection.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('Backup integrity check failed')
        print(json.dumps({'backedUp': True}))
    else:
        raise ValueError('Unsupported SQLite command')
finally:
    connection.close()