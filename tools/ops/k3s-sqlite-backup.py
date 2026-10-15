"""Internal root-only helper streamed by velura-ops; never installs or restarts K3s.

Only the canonical CLI authorizes creation. The SQLite online backup API creates
one consistent database; an ordinary copy of state.db with its WAL is unsafe.
Output is metadata only. Configuration and the server token stay in mode-600
files under a mode-700 local bundle, which is NOT offsite disaster recovery.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

SERVER = Path('/var/lib/rancher/k3s/server')
SOURCE = SERVER / 'db/state.db'
TOKEN = SERVER / 'token'
ROOT = Path('/var/backups/velura-k3s')
MAX_FILE = 16 * 1024 * 1024
ENVIRONMENT_FILES = [Path('/etc/default/k3s'), Path('/etc/sysconfig/k3s'),
                     Path('/etc/systemd/system/k3s.service.env')]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=10).stdout


def regular(path, nonempty=False):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and (not nonempty or info.st_size > 0),
            'Required recovery material is not a regular nonempty file')
    return info


def materials():
    # No Kubernetes Secret export, kubeconfig, arbitrary home-directory copy, or
    # application payloads. These files are specifically K3s recovery inputs.
    paths = [TOKEN]
    for path in [Path('/etc/rancher/k3s/config.yaml'),
                 Path('/etc/rancher/k3s/registries.yaml'),
                 *ENVIRONMENT_FILES, SERVER / 'cred/encryption-config.json']:
        if path.exists():
            paths.append(path)
    fragments = Path('/etc/rancher/k3s/config.yaml.d')
    if fragments.exists():
        require(fragments.is_dir() and not fragments.is_symlink(), 'Unsupported K3s configuration directory')
        paths.extend(sorted(fragments.glob('*.yaml')))
    for path in paths:
        require(regular(path, path == TOKEN).st_size <= MAX_FILE, 'Recovery material exceeds safe file limit')
    return paths


def prerequisites(uid):
    require(os.geteuid() == 0, 'Root is required for protected K3s recovery materials')
    # Repeat identity inside the helper immediately before any filesystem write.
    actual = json.loads(command(['k3s', 'kubectl', '--request-timeout=10s', 'get',
                                 'namespace', 'kube-system', '-o', 'json']))
    require(actual.get('metadata', {}).get('uid') == uid, 'Cluster identity mismatch')
    regular(SOURCE, True)
    with SOURCE.open('rb') as source:
        require(source.read(16) == b'SQLite format 3\x00', 'Active datastore is not SQLite')
    pid = command(['systemctl', 'show', 'k3s', '--property=MainPID', '--value']).strip()
    require(pid.isdigit() and int(pid) > 0, 'Running K3s service is required')
    process = Path('/proc') / pid
    require(any(os.path.realpath(fd) == str(SOURCE) for fd in (process / 'fd').iterdir()),
            'K3s does not have the expected SQLite datastore open; custom/external/etcd layouts are unsupported')
    arguments = (process / 'cmdline').read_bytes().decode().split('\x00')
    environment = dict(item.split('=', 1) for item in (process / 'environ').read_bytes().decode().split('\x00') if '=' in item)
    require(environment.get('K3S_CONFIG_FILE', '/etc/rancher/k3s/config.yaml') == '/etc/rancher/k3s/config.yaml'
            and environment.get('K3S_DATA_DIR', '/var/lib/rancher/k3s') == '/var/lib/rancher/k3s',
            'Custom K3s configuration/data directory requires a separately reviewed recovery inventory')
    require(not any(arg == '--config' or arg.startswith('--config=') or arg == '--data-dir' or arg.startswith('--data-dir=') for arg in arguments),
            'Custom K3s configuration/data directory requires a separately reviewed recovery inventory')
    require(not any(environment.get(key) for key in ['K3S_TOKEN_FILE', 'K3S_AGENT_TOKEN_FILE',
                                                     'K3S_PRIVATE_REGISTRY', 'K3S_FLANNEL_CONF',
                                                     'K3S_FLANNEL_CNI_CONF']),
            'External K3s file references require a separately reviewed recovery inventory')
    external_file = re.compile(r'(?i)(?:^|\s)(?:-c|--(?:config|data-dir|token-file|agent-token-file|private-registry|flannel-conf|flannel-cni-conf|kubeconfig|kube-apiserver-arg|kube-controller-manager-arg|kube-scheduler-arg|kubelet-arg|kube-proxy-arg))(?:[=\s]|$)')
    require(not external_file.search(' '.join(arguments)),
            'External K3s file references require a separately reviewed recovery inventory')
    files = materials()
    service = command(['systemctl', 'cat', 'k3s'])
    # Standard installer unit paths use %N (the unit name without .service).
    # Preserve those files if present, and reject unreviewed environment sources.
    envfiles = re.findall(r'^\s*EnvironmentFile\s*=\s*(.+)$', service, re.MULTILINE)
    require(all(value.strip().lstrip('-').strip('"').replace('%N', 'k3s').replace('%n', 'k3s.service')
                in {str(path) for path in ENVIRONMENT_FILES} for value in envfiles if value.strip()),
            'Additional K3s EnvironmentFile requires a reviewed recovery inventory')
    require(not external_file.search(service),
            'External K3s file references require a separately reviewed recovery inventory')
    configuration = [path for path in files if path.suffix == '.yaml']
    # Custom component arguments and registry certificate paths can depend on
    # files outside this explicit inventory. Refuse rather than omit them.
    config_reference = re.compile(r'(?:^|[\s,{])["\']?(?:data-dir|config|token-file|agent-token-file|private-registry|flannel-conf|flannel-cni-conf|kube-apiserver-arg|kube-controller-manager-arg|kube-scheduler-arg|kubelet-arg|kube-proxy-arg|ca_file|cert_file|key_file)["\']?\s*[+:]')
    require(not any(config_reference.search(path.read_text()) for path in configuration),
            'Custom K3s configuration references require a separately reviewed recovery inventory')
    require(len(service.encode()) <= MAX_FILE, 'K3s service configuration exceeds safe limit')
    version = command(['k3s', '--version']).splitlines()[0]
    require(re.fullmatch(r'k3s version v[0-9A-Za-z.+_-]+ \([a-f0-9]+\)', version) is not None,
            'Unexpected K3s version response')
    return files, service, version


def private_directory(path, create=False):
    # Reject symlinked ancestors and other-writable directories before writing
    # privileged files; never chmod/chown an existing user-owned directory.
    for parent in list(path.parents)[::-1]:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Backup ancestors must be root-owned non-writable real directories')
    if not path.exists() and create:
        path.mkdir(mode=0o700)
    if path.exists():
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
                'Backup directory must be root-owned with mode 700 and not a symlink')


def protected_write(path, data):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open('xb') as target:
        os.chmod(path, 0o600)
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


def create(uid, environment, revision, seconds):
    files, service, version = prerequisites(uid)
    private_directory(ROOT, create=True)
    required_bytes = SOURCE.stat().st_size * 2 + sum(path.stat().st_size for path in files) + 64 * 1024 * 1024
    require(shutil.disk_usage(ROOT).free >= required_bytes, 'Insufficient disk space for a bounded local SQLite backup')
    stage = Path(tempfile.mkdtemp(prefix='.incomplete-', dir=ROOT))
    started = time.monotonic()
    try:
        # Capture recovery inputs before the snapshot and compare afterwards to
        # detect concurrent token/configuration rotation.
        for path in files:
            protected_write(stage / 'recovery' / path.relative_to('/'), path.read_bytes())
        protected_write(stage / 'recovery/k3s.service.effective', service.encode())
        destination = stage / 'state.db'
        # mode=ro never changes the source DB. pages/progress impose a deadline,
        # including retries when another writer holds a database lock.
        source = sqlite3.connect(SOURCE.as_uri() + '?mode=ro', uri=True, timeout=2)
        target = sqlite3.connect(destination, timeout=2)
        try:
            target.set_progress_handler(lambda: int(time.monotonic() - started >= seconds), 1000)
            def progress(status, remaining, total):
                require(time.monotonic() - started < seconds, 'SQLite online backup deadline exceeded')
            source.backup(target, pages=256, progress=progress, sleep=0.05)
            target.execute('PRAGMA journal_mode=DELETE')
            require(target.execute('PRAGMA integrity_check').fetchall() == [('ok',)],
                    'SQLite backup integrity verification failed')
        finally:
            target.close()
            source.close()
        os.chmod(destination, 0o600)
        with destination.open('rb') as handle:
            os.fsync(handle.fileno())
        # Detect token/config changes during the snapshot rather than publishing
        # an inconsistent recovery set across a concurrent configuration rotation.
        require(materials() == files and command(['systemctl', 'cat', 'k3s']) == service
                and all((stage / 'recovery' / path.relative_to('/')).read_bytes() == path.read_bytes() for path in files),
                'K3s recovery material changed during backup; retry after configuration changes finish')
        entries = []
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                digest = hashlib.sha256()
                with path.open('rb') as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                        digest.update(chunk)
                entries.append({'path': str(path.relative_to(stage)), 'sha256': digest.hexdigest(), 'bytes': path.stat().st_size})
        completed = datetime.datetime.now(datetime.timezone.utc)
        manifest = {
            'version': 1, 'datastore': 'sqlite', 'method': 'sqlite3.Connection.backup',
            'clusterUid': uid, 'environment': environment, 'declaredGitRevision': revision,
            'k3sVersion': version, 'completedAt': completed.isoformat(),
            'integrityCheck': 'ok', 'storageLocation': 'local', 'offsiteVerified': False,
            'restoreVerified': False, 'files': entries,
            'externalRequirements': ['Independent encrypted off-VM transfer and repository credentials',
                                     'Matching Git revision and independently held SOPS age recovery key',
                                     'Owner-approved isolated recovery host, network and RPO/RTO'],
            'recoveryContract': [
                'Verify every manifest SHA256 before use; preserve root-only permissions.',
                'Use a separate isolated host and the recorded exact K3s version; never overwrite a running cluster.',
                'Install K3s without starting it; review effective unit/config/env for host-specific paths and network settings.',
                'With K3s stopped on that isolated host, place state.db at /var/lib/rancher/k3s/server/db/state.db and the saved token at /var/lib/rancher/k3s/server/token.',
                'Restore reviewed config, service environment and any saved encryption-config.json with original paths and mode 600; do not use etcd snapshot/reset commands.',
                'Start only the isolated recovery service after owner approval; verify cluster UID, encrypted Secret readability, Flux suspension and business data separately.',
                'Record actual offsite snapshot identity, checksums, measured restore duration and business integrity; this bundle does not prove a recovery drill.'
            ]}
        encoded = json.dumps(manifest, indent=2).encode() + b'\n'
        protected_write(stage / 'manifest.json', encoded)
        # Persist children before atomically publishing the completed bundle.
        for path in [*sorted((item for item in stage.rglob('*') if item.is_dir()), reverse=True), stage]:
            descriptor = os.open(path, os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        name = completed.strftime('%Y%m%dT%H%M%SZ-') + stage.name[len('.incomplete-'):]
        final = ROOT / name
        stage.rename(final)
        directory_fd = os.open(ROOT, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return {'datastore': 'sqlite', 'created': True, 'bundle': str(final),
                'integrityCheck': 'ok', 'manifestSha256': hashlib.sha256(encoded).hexdigest(),
                'protectedServerToken': True, 'storageLocation': 'local',
                'offsiteVerified': False, 'restoreVerified': False}
    except BaseException:
        # Only this invocation's unpublished temporary directory is removed.
        shutil.rmtree(stage, ignore_errors=True)
        raise


def deadline_expired(signum, frame):
    raise RuntimeError('K3s backup helper deadline exceeded')


def main():
    os.umask(0o077)
    mode, uid, environment, revision, seconds = sys.argv[1:]
    require(mode in ['inspect', 'create'], 'Unsupported internal backup operation')
    require(re.fullmatch(r'[a-zA-Z0-9-]{8,128}', uid) and environment in ['staging', 'production']
            and re.fullmatch(r'[a-f0-9]{40}', revision), 'Invalid internal backup identity')
    seconds = float(seconds)
    require(0 < seconds <= 55, 'Invalid internal backup deadline')
    signal.signal(signal.SIGALRM, deadline_expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    if mode == 'create':
        result = create(uid, environment, revision, seconds)
    else:
        files, service, version = prerequisites(uid)
        private_directory(ROOT)
        result = {'datastore': 'sqlite', 'created': False, 'k3sVersion': version,
                  'recoveryFileCount': len(files) + 1, 'protectedServerToken': True,
                  'storageLocation': 'local', 'offsiteVerified': False, 'restoreVerified': False}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(json.dumps({'error': str(error)}))
    except Exception:
        print(json.dumps({'error': 'Backup failed; filesystem/process/database details withheld to protect credentials'}))
