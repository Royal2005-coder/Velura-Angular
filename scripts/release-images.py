"""Prepare reviewed environment image pins and verify their staging provenance; never contact Kubernetes."""

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys


APPS = ('api', 'storefront', 'admin')
ROOT = Path('deploy/k8s/overlays')
EVIDENCE = Path('deploy/releases/production.json')
REPOSITORY = 'Royal2005-coder/Velura-Angular'
IMAGE_PREFIX = 'ghcr.io/royal2005-coder/velura-'


def snapshot(environment, reader=lambda path: path.read_text(encoding='utf-8')):
    """Read the complete app release; reject mutable, missing, duplicate or foreign image pins."""
    import yaml
    overlay = ROOT / environment
    entries = yaml.safe_load(reader(overlay / 'kustomization.yaml')).get('images', [])
    images = {}
    for app in APPS:
        name = IMAGE_PREFIX + app
        matches = [item for item in entries if item.get('name') == name]
        if len(matches) != 1:
            raise ValueError(f'Expected one {app} image pin in {environment}')
        item = matches[0]
        if item.get('newName', name) != name or item.get('newTag') or not re.fullmatch(r'sha256:[a-f0-9]{64}', item.get('digest', '')):
            raise ValueError(f'Expected immutable canonical {app} image in {environment}')
        images[app] = name + '@' + item['digest']
    revision = yaml.safe_load(reader(overlay / 'release-revision.yaml'))['data']['RELEASE_REVISION']
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Expected full immutable release revision')
    return {'revision': revision, 'images': images}


def update(environment, release):
    """Change only one environment's image transformer and release ConfigMap patch."""
    import yaml
    overlay = ROOT / environment
    path = overlay / 'kustomization.yaml'
    text = path.read_text(encoding='utf-8')
    entries = yaml.safe_load(text).get('images', [])
    names = {IMAGE_PREFIX + app for app in APPS}
    entries = [item for item in entries if item.get('name') not in names]
    for app in APPS:
        name, digest = release['images'][app].split('@')
        entries.append({'name': name, 'newName': name, 'digest': digest})
    block = yaml.safe_dump({'images': entries}, sort_keys=False)
    text, count = re.subn(r'(?m)^images:\n(?:[ \t].*\n|-[^\n]*\n|\n)*', lambda _: block, text)
    if count != 1:
        raise ValueError('Expected one overlay images block')
    path.write_text(text, encoding='utf-8')
    path = overlay / 'release-revision.yaml'
    text, count = re.subn(r'(?m)^(\s+RELEASE_REVISION:)\s+\S+', lambda match: match[1] + ' ' + release['revision'], path.read_text(encoding='utf-8'))
    if count != 1:
        raise ValueError('Expected one overlay release revision')
    path.write_text(text, encoding='utf-8')
    if snapshot(environment) != release:
        raise ValueError('Written release does not match requested release')


def gh_json(*args):
    """Read canonical GitHub release evidence using the caller's read-only API credentials."""
    return json.loads(subprocess.check_output(['gh', 'api', *args], text=True))


def remote_snapshot(environment, sha):
    def reader(path):
        response = gh_json(f'repos/{REPOSITORY}/contents/{path.as_posix()}?ref={sha}')
        return base64.b64decode(response['content']).decode('utf-8')
    return snapshot(environment, reader)


def validate_bootstrap(base_sha):
    """Allow only unchanged legacy pins while production Flux remains suspended."""
    import yaml
    if not re.fullmatch(r'[a-f0-9]{40}', base_sha):
        raise ValueError('Bootstrap validation requires the immutable PR base SHA')
    def reader(path):
        return subprocess.check_output(['git', 'show', f'{base_sha}:{path.as_posix()}'], text=True)
    if subprocess.run(['git', 'cat-file', '-e', f'{base_sha}:{EVIDENCE.as_posix()}'], capture_output=True).returncode == 0:
        raise ValueError('Existing production evidence must not be removed')
    revision_path = ROOT / 'production' / 'release-revision.yaml'
    if subprocess.run(['git', 'cat-file', '-e', f'{base_sha}:{revision_path.as_posix()}'], capture_output=True).returncode == 0:
        baseline = snapshot('production', reader)
    else:
        images = {}
        revision = None
        for app in APPS:
            for resource in yaml.safe_load_all(reader(Path(f'deploy/k8s/base/velura/velura-{app}.yaml'))):
                if resource and resource.get('kind') == 'ConfigMap' and resource.get('metadata', {}).get('name') == 'velura-api-config':
                    revision = resource['data']['RELEASE_REVISION']
                if resource and resource.get('kind') == 'Deployment':
                    containers = resource['spec']['template']['spec']['containers']
                    matches = [container['image'] for container in containers if container['name'] == 'velura-' + app]
                    if len(matches) != 1 or not re.fullmatch(re.escape(IMAGE_PREFIX + app) + r'(?::[^@\s]+)?@sha256:[a-f0-9]{64}', matches[0]):
                        raise ValueError('Legacy bootstrap base must already have immutable app pins')
                    images[app] = IMAGE_PREFIX + app + '@' + matches[0].split('@')[1]
        baseline = {'revision': revision, 'images': images}
    if snapshot('production') != baseline:
        raise ValueError('Production pin changes require successful staging provenance, even while suspended')
    resources = list(yaml.safe_load_all(Path('deploy/k8s/base/flux/git-sync.yaml').read_text(encoding='utf-8')))
    matches = [resource for resource in resources if resource and resource.get('kind') == 'Kustomization' and resource.get('metadata', {}).get('name') == 'velura-production']
    if len(matches) != 1 or matches[0].get('spec', {}).get('suspend') is not True:
        raise ValueError('Bootstrap production Flux must remain explicitly suspended')
    print('Unchanged legacy pins only: production Flux remains suspended; no verified release is claimed.')


def validate_production(bootstrap_base=None):
    """Require the exact production bundle to have passed this workflow's staging verification."""
    if not EVIDENCE.exists() and bootstrap_base:
        validate_bootstrap(bootstrap_base)
        return
    evidence = json.loads(EVIDENCE.read_text(encoding='utf-8'))
    run = gh_json(f'repos/{REPOSITORY}/actions/runs/{int(evidence["run_id"])}')
    if run['repository']['full_name'] != REPOSITORY or run['path'] != '.github/workflows/ci.yml' or run['event'] != 'push' or run['head_branch'] != 'develop' or run['head_sha'] != evidence['source_sha']:
        raise ValueError('Production evidence is not a canonical develop verification run')
    jobs = gh_json(f'repos/{REPOSITORY}/actions/runs/{run["id"]}/jobs?per_page=100')['jobs']
    verified = [job for job in jobs if job['name'] == 'verify-staging' and job['conclusion'] == 'success']
    if len(verified) != 1:
        raise ValueError('Staging verification has not succeeded for this run')
    staged = remote_snapshot('staging', run['head_sha'])
    if staged != evidence['release'] or staged != snapshot('production'):
        raise ValueError('Production image bundle differs from the verified staging bundle')


def sanitize(app):
    """Publish allowlisted scanner fields, never secret matches, source snippets or image configuration."""
    directory = Path('diagnostics')
    directory.mkdir(exist_ok=True)
    status = {'app': app, 'scan': os.environ.get('SCAN_OUTCOME', 'not-run'), 'sbom': os.environ.get('SBOM_OUTCOME', 'not-run'), 'scanner': os.environ.get('SCANNER_OUTCOME', 'not-run'), 'digest': os.environ.get('IMAGE_DIGEST', ''), 'invalid_reports': [], 'note': 'Absent reports mean the scanner did not produce them; no passing scan is implied.'}
    (directory / 'status.json').write_text(json.dumps(status, indent=2), encoding='utf-8')
    def report(path):
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError):
            status['invalid_reports'].append(path.name)
            return None
    path = Path(f'scan-{app}.json')
    data = report(path)
    if data is not None:
        results = []
        for result in data.get('Results', []):
            safe = {key: result[key] for key in ('Target', 'Class', 'Type') if key in result}
            safe['Vulnerabilities'] = [{key: finding[key] for key in ('VulnerabilityID', 'PkgName', 'InstalledVersion', 'FixedVersion', 'Severity', 'Status', 'PrimaryURL') if key in finding} for finding in result.get('Vulnerabilities', [])]
            safe['Secrets'] = [{key: finding[key] for key in ('RuleID', 'Category', 'Title', 'Severity', 'StartLine', 'EndLine') if key in finding} for finding in result.get('Secrets', [])]
            results.append(safe)
        (directory / path.name).write_text(json.dumps({'SchemaVersion': data.get('SchemaVersion'), 'Results': results}, indent=2), encoding='utf-8')
    path = Path(f'sbom-{app}.json')
    data = report(path)
    if data is not None:
        safe = {key: data[key] for key in ('spdxVersion', 'dataLicense', 'SPDXID', 'name', 'documentNamespace', 'creationInfo', 'relationships') if key in data}
        safe['packages'] = [{key: package[key] for key in ('SPDXID', 'name', 'versionInfo', 'downloadLocation', 'filesAnalyzed', 'licenseConcluded', 'licenseDeclared', 'copyrightText', 'checksums', 'externalRefs') if key in package} for package in data.get('packages', [])]
        (directory / path.name).write_text(json.dumps(safe, indent=2), encoding='utf-8')
    (directory / 'status.json').write_text(json.dumps(status, indent=2), encoding='utf-8')


def main():
    command, *args = sys.argv[1:]
    if command == 'snapshot':
        print(json.dumps(snapshot(args[0]), sort_keys=True))
    elif command == 'stage':
        directory, revision = args
        if not re.fullmatch(r'[a-f0-9]{40}', revision):
            raise ValueError('Expected full release SHA')
        images = {}
        for app in APPS:
            image = (Path(directory) / f'image-{app}.txt').read_text(encoding='utf-8').strip()
            if not re.fullmatch(re.escape(IMAGE_PREFIX + app) + r'@sha256:[a-f0-9]{64}', image):
                raise ValueError(f'Invalid {app} release artifact')
            images[app] = image
        update('staging', {'revision': revision, 'images': images})
    elif command == 'worker':
        image = (Path(args[0]) / 'image-ai-worker.txt').read_text(encoding='utf-8').strip()
        if not re.fullmatch(re.escape(IMAGE_PREFIX + 'ai-worker') + r'@sha256:[a-f0-9]{64}', image):
            raise ValueError('Invalid optional worker release artifact')
        for name in ('worker.yaml', 'provision-weights.yaml'):
            path = Path('deploy/k8s/optional/ai-worker') / name
            text, count = re.subn(r'(?m)^(\s*image:)\s+\S+', lambda match: match[1] + ' ' + image, path.read_text(encoding='utf-8'))
            if count != 1:
                raise ValueError('Expected one optional worker image; replicas and enablement must not change')
            path.write_text(text, encoding='utf-8')
    elif command == 'production':
        source_sha, run_id = args
        release = remote_snapshot('staging', source_sha)
        if snapshot('staging') != release:
            raise ValueError('Staging changed while verification ran; verify the new release before promotion')
        update('production', release)
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps({'source_sha': source_sha, 'run_id': int(run_id), 'release': release}, indent=2) + '\n', encoding='utf-8')
        validate_production()
    elif command == 'validate-production':
        validate_production(bootstrap_base=args[0] if args else None)
    elif command == 'sanitize':
        sanitize(args[0])
    else:
        raise ValueError('Unknown release operation')


if __name__ == '__main__':
    main()
