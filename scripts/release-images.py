"""Promote signed main builds to reviewed MVP production pins; never contact Kubernetes."""

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys


APPS = ('api', 'storefront', 'admin', 'admin-erp')
ROOT = Path('deploy/k8s/overlays')
EVIDENCE = Path('deploy/releases/production.json')
REPOSITORY = 'Royal2005-coder/Velura-Angular'
IMAGE_PREFIX = 'ghcr.io/royal2005-coder/velura-'


def require_build_id(revision, build_id):
    """Bind an immutable image build to its source revision and exact Actions run attempt."""
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Expected full immutable release revision')
    if not isinstance(build_id, str) or not re.fullmatch(re.escape(revision) + r'-[0-9]+-[0-9]+', build_id):
        raise ValueError('Expected revision-bound immutable release build ID')
    return build_id


def require_release(release):
    """Reject legacy snapshots as promotion or runtime-verification evidence."""
    require_build_id(release['revision'], release.get('buildId'))
    if set(release.get('images', {})) != set(APPS):
        raise ValueError('Expected the complete application release bundle')
    for app in APPS:
        if not re.fullmatch(re.escape(IMAGE_PREFIX + app) + r'@sha256:[a-f0-9]{64}', release['images'][app]):
            raise ValueError('Expected canonical immutable release image')
    return release


def artifact_release(directory, revision, build_id):
    """Read every signed build artifact and reject mixed runs or rerun attempts."""
    require_build_id(revision, build_id)
    images = {}
    for app in APPS:
        image = (Path(directory) / f'image-{app}.txt').read_text(encoding='utf-8').strip()
        identity = (Path(directory) / f'build-id-{app}.txt').read_text(encoding='utf-8').strip()
        if not re.fullmatch(re.escape(IMAGE_PREFIX + app) + r'@sha256:[a-f0-9]{64}', image):
            raise ValueError(f'Invalid {app} release artifact')
        if identity != build_id:
            raise ValueError(f'Mismatched {app} release build artifact')
        images[app] = image
    return {'revision': revision, 'buildId': build_id, 'images': images}


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
    data = yaml.safe_load(reader(overlay / 'release-revision.yaml'))['data']
    revision = data['RELEASE_REVISION']
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Expected full immutable release revision')
    build_id = data.get('RELEASE_BUILD_ID')
    if 'RELEASE_BUILD_ID' in data:
        require_build_id(revision, build_id)
    return {'revision': revision, 'buildId': build_id, 'images': images}


def update(environment, release):
    """Change only one environment's image transformer and release ConfigMap patch."""
    import yaml
    require_release(release)
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
    text = path.read_text(encoding='utf-8')
    build_lines = re.findall(r'(?m)^\s+RELEASE_BUILD_ID:.*$', text)
    if len(build_lines) > 1:
        raise ValueError('Expected at most one overlay release build ID')
    if build_lines:
        text = re.sub(r'(?m)^(\s+RELEASE_BUILD_ID:)[^\n]*', lambda match: match[1] + ' ' + release['buildId'], text)
    text, count = re.subn(r'(?m)^([ \t]+)RELEASE_REVISION:[^\n]*', lambda match: match[1] + 'RELEASE_REVISION: ' + release['revision'] + ('' if build_lines else '\n' + match[1] + 'RELEASE_BUILD_ID: ' + release['buildId']), text)
    if count != 1:
        raise ValueError('Expected one overlay release revision')
    path.write_text(text, encoding='utf-8')
    if snapshot(environment) != release:
        raise ValueError('Written release does not match requested release')


def gh_json(*args):
    """Read canonical GitHub release evidence using the caller's read-only API credentials."""
    environment = os.environ.copy()
    if environment.get('GH_READ_TOKEN'):
        environment['GH_TOKEN'] = environment['GH_READ_TOKEN']
    return json.loads(subprocess.check_output(['gh', 'api', *args], text=True, env=environment, timeout=60))


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
        baseline = {'revision': revision, 'buildId': None, 'images': images}
    if snapshot('production') != baseline:
        raise ValueError('Production pin changes require successful signed-main provenance, even while suspended')
    resources = list(yaml.safe_load_all(Path('deploy/k8s/base/flux/git-sync.yaml').read_text(encoding='utf-8')))
    matches = [resource for resource in resources if resource and resource.get('kind') == 'Kustomization' and resource.get('metadata', {}).get('name') == 'velura-production']
    if len(matches) != 1 or matches[0].get('spec', {}).get('suspend') is not True:
        raise ValueError('Bootstrap production Flux must remain explicitly suspended')
    print('Unchanged legacy pins only: production Flux remains suspended; no verified release is claimed.')


def validate_published_evidence(evidence, require_current_source=False):
    """Require successful main CI and every scan/sign publisher in the exact build attempt."""
    release = require_release(evidence['release'])
    if evidence.get('mode') != 'direct-mvp':
        raise ValueError('Expected explicit direct-mvp release provenance')
    run_id, attempt = int(evidence['run_id']), int(evidence['run_attempt'])
    if run_id <= 0 or attempt <= 0 or release['buildId'] != f'{release["revision"]}-{run_id}-{attempt}':
        raise ValueError('Release does not belong to the recorded run attempt')
    run = gh_json(f'repos/{REPOSITORY}/actions/runs/{run_id}')
    if (run['id'] != run_id or run['repository']['full_name'] != REPOSITORY or
        run['path'] != '.github/workflows/ci.yml' or run['event'] not in ('push', 'workflow_dispatch') or
        run['head_branch'] != 'main' or run['head_sha'] != evidence['source_sha'] or
        run['head_sha'] != release['revision']):
        raise ValueError('Production evidence is not a canonical main publisher run')
    jobs = gh_json(f'repos/{REPOSITORY}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100')['jobs']
    required = ['validate', 'test-api', 'test-angular', 'test-ai-worker', 'build', 'migrations', 'manifests']
    required += [f'deploy-production ({app})' for app in (*APPS, 'ai-worker')]
    for name in required:
        matches = [job for job in jobs if job['name'] == name]
        if len(matches) != 1 or matches[0].get('conclusion') != 'success':
            raise ValueError(f'Required main publication gate did not succeed: {name}')
    if require_current_source:
        comparison = gh_json(f'repos/{REPOSITORY}/compare/{release["revision"]}...main')
        if comparison.get('status') not in ('identical', 'ahead') or len(comparison.get('files', [])) >= 300:
            raise ValueError('Cannot prove that the publisher source is current on main')
        source = r'^(apps/|packages/|database/migrations/|scripts/(run-migrations|supabase-project)\.mjs$|package(-lock)?\.json$|deploy/docker/)'
        if any(re.search(source, item['filename']) for item in comparison.get('files', [])):
            raise ValueError('Application source changed on main after this build; publish the current source')
    return release


def validate_production(bootstrap_base=None):
    """Bind production pins to successful main publication; CI also verifies Cosign signatures."""
    if not EVIDENCE.exists() and bootstrap_base:
        validate_bootstrap(bootstrap_base)
        return
    evidence = json.loads(EVIDENCE.read_text(encoding='utf-8'))
    changed = False
    if bootstrap_base:
        previous = subprocess.run(['git', 'show', f'{bootstrap_base}:{EVIDENCE.as_posix()}'], capture_output=True, text=True)
        changed = previous.returncode != 0 or json.loads(previous.stdout) != evidence
    release = validate_published_evidence(evidence, require_current_source=changed)
    if release != snapshot('production'):
        raise ValueError('Production image bundle differs from the approved publisher evidence')


def activate_production_flux():
    """Flip only the production owner's suspend flag, preserving the reviewed file verbatim."""
    path = Path('deploy/k8s/base/flux/git-sync.yaml')
    documents = path.read_text(encoding='utf-8').split('\n---\n')
    owners = [position for position, document in enumerate(documents)
              if re.search(r'(?m)^kind: Kustomization$', document) and re.search(r'(?m)^  name: velura-production$', document)]
    if len(owners) != 1:
        raise ValueError('Expected one production Flux owner')
    document = documents[owners[0]]
    if re.search(r'(?m)^  suspend: false$', document):
        return
    document, count = re.subn(r'(?m)^  suspend: true$', '  suspend: false', document)
    if count != 1:
        raise ValueError('Expected explicitly suspended production Flux owner')
    documents[owners[0]] = document
    path.write_text('\n---\n'.join(documents), encoding='utf-8')


def include_production_secrets():
    """Append the encrypted production Secret snapshot to the overlay resources once."""
    secret_root = Path('deploy/k8s/secrets/production/kustomization.yaml')
    if not secret_root.exists():
        return
    path = ROOT / 'production/kustomization.yaml'
    text = path.read_text(encoding='utf-8')
    if '../../secrets/production' in text:
        return
    block = re.compile(r'(?m)^resources:\n(?P<items>(?:[ \t]*-[^\n]*\n)*)')
    match = block.search(text)
    if not match:
        raise ValueError('Expected a resources block in the production overlay')
    path.write_text(text[:match.end('items')] + '- ../../secrets/production\n' + text[match.end('items'):], encoding='utf-8')


def prepare_direct_release(directory, revision, build_id, run_id, run_attempt):
    """Prepare the first or next production release and its declarative Flux activation."""
    release = artifact_release(directory, revision, build_id)
    evidence = {'mode': 'direct-mvp', 'source_sha': revision, 'run_id': int(run_id),
                'run_attempt': int(run_attempt), 'release': release}
    validate_published_evidence(evidence, require_current_source=True)
    update('production', release)
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    activate_production_flux()
    include_production_secrets()
    validate_production()


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
    elif command == 'verified-snapshot':
        print(json.dumps(require_release(snapshot(args[0])), sort_keys=True))
    elif command == 'stage':
        directory, revision, build_id = args
        update('staging', artifact_release(directory, revision, build_id))
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
    elif command == 'direct':
        prepare_direct_release(*args)
    elif command == 'validate-production':
        validate_production(bootstrap_base=args[0] if args else None)
    elif command == 'sanitize':
        sanitize(args[0])
    else:
        raise ValueError('Unknown release operation')


if __name__ == '__main__':
    main()
