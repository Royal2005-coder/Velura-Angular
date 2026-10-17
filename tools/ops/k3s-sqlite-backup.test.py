"""Local-only regression tests; no K3s, SSH or privileged host writes."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('k3s_backup', Path(__file__).with_name('k3s-sqlite-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


@unittest.skipUnless(os.name == 'posix', 'Helper requires a Linux/POSIX filesystem')
class BackupBoundaries(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'state.db'
        self.token = self.base / 'token'
        self.token.write_bytes(b'synthetic-sensitive-server-token')
        self.root = self.base / 'bundles'
        self.root.mkdir(mode=0o700)
        self.writer = sqlite3.connect(self.source)
        self.addCleanup(self.writer.close)
        self.writer.execute('PRAGMA journal_mode=WAL')
        self.writer.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)')
        self.writer.execute("INSERT INTO items(value) VALUES ('committed WAL record')")
        self.writer.commit()
        for name, value in [('SOURCE', self.source), ('TOKEN', self.token), ('ROOT', self.root)]:
            setting = patch.object(backup, name, value)
            setting.start()
            self.addCleanup(setting.stop)
        previous = os.umask(0o077)
        self.addCleanup(os.umask, previous)

    def run_backup(self):
        with patch.object(backup, 'prerequisites', return_value=([self.token], 'synthetic unit', 'k3s version v1.30.0+k3s1 (abcdef)')), \
                patch.object(backup, 'private_directory'), \
                patch.object(backup, 'materials', return_value=[self.token]), \
                patch.object(backup, 'command', return_value='synthetic unit'):
            return backup.create('11111111-2222-3333-4444-555555555555', 'staging', 'a' * 40, 10)

    def test_online_backup_contains_committed_wal_and_private_recovery_inputs(self):
        result = self.run_backup()
        bundle = Path(result['bundle'])
        with sqlite3.connect(bundle / 'state.db') as snapshot:
            self.assertEqual(snapshot.execute('SELECT value FROM items').fetchall(), [('committed WAL record',)])
        self.assertEqual(self.writer.execute('SELECT COUNT(*) FROM items').fetchone(), (1,))
        self.assertFalse(result['offsiteVerified'])
        self.assertFalse(result['restoreVerified'])
        self.assertNotIn('synthetic-sensitive-server-token', json.dumps(result))
        manifest = json.loads((bundle / 'manifest.json').read_text())
        self.assertTrue(any(item['path'].endswith('/token') for item in manifest['files']))
        for path in [bundle, *bundle.rglob('*')]:
            self.assertEqual(path.stat().st_uid, os.geteuid())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_token_rotation_during_snapshot_removes_unpublished_bundle(self):
        real_connect = sqlite3.connect

        def rotate_on_database_open(*args, **kwargs):
            self.token.write_bytes(b'rotated-synthetic-token')
            return real_connect(*args, **kwargs)

        with patch.object(backup.sqlite3, 'connect', side_effect=rotate_on_database_open):
            with self.assertRaisesRegex(RuntimeError, 'recovery material changed'):
                self.run_backup()
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.writer.execute('SELECT COUNT(*) FROM items').fetchone(), (1,))

    def test_failed_backup_does_not_publish_or_leave_credentials(self):
        with patch.object(backup.sqlite3, 'connect', side_effect=sqlite3.OperationalError('synthetic failure')):
            with self.assertRaises(sqlite3.OperationalError):
                self.run_backup()
        self.assertEqual(list(self.root.iterdir()), [])

    def test_inspect_never_creates_bundle_or_connects_to_sqlite(self):
        arguments = ['helper', 'inspect', '11111111-2222-3333-4444-555555555555', 'staging', 'a' * 40, '10']
        with patch.object(backup.sys, 'argv', arguments), \
                patch.object(backup, 'prerequisites', return_value=([self.token], 'unit', 'version')), \
                patch.object(backup, 'private_directory') as directory, \
                patch.object(backup.sqlite3, 'connect', side_effect=AssertionError('inspect must not open DB')), \
                patch.object(backup.signal, 'signal'), patch.object(backup.signal, 'setitimer'), \
                patch('builtins.print') as output:
            backup.main()
        directory.assert_called_once_with(self.root)
        self.assertFalse(json.loads(output.call_args.args[0])['created'])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_private_directory_rejects_symlink_and_other_writable_ancestor(self):
        link = self.base / 'linked'
        link.symlink_to(self.root, target_is_directory=True)
        def safe_stat(path):
            return SimpleNamespace(st_uid=0, st_mode=(stat.S_IFLNK if path == link else stat.S_IFDIR) | 0o700)
        with patch.object(Path, 'lstat', autospec=True, side_effect=safe_stat):
            with self.assertRaisesRegex(RuntimeError, 'not a symlink'):
                backup.private_directory(link)
        def writable_ancestor(path):
            return SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | (0o777 if path == self.base else 0o700))
        with patch.object(Path, 'lstat', autospec=True, side_effect=writable_ancestor):
            with self.assertRaisesRegex(RuntimeError, 'ancestors'):
                backup.private_directory(self.root)


if __name__ == '__main__':
    unittest.main()
