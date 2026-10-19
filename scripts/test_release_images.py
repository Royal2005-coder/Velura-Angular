"""Behavioral coverage for release pin isolation, provenance and redacted diagnostics."""

import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

spec = importlib.util.spec_from_file_location('release_images', Path(__file__).with_name('release-images.py'))
release_images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_images)


class ReleaseImagesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(os.chdir, self.previous)
        self.release = {'revision': 'a' * 40, 'images': {app: release_images.IMAGE_PREFIX + app + '@sha256:' + str(number) * 64 for number, app in enumerate(release_images.APPS, 1)}}
        for environment in ('staging', 'production'):
            root = release_images.ROOT / environment
            root.mkdir(parents=True)
            pins = [{'name': image.split('@')[0], 'newName': image.split('@')[0], 'digest': image.split('@')[1]} for image in self.release['images'].values()]
            (root / 'kustomization.yaml').write_text(yaml.safe_dump({'apiVersion': 'kustomize.config.k8s.io/v1beta1', 'kind': 'Kustomization', 'resources': ['../../base/velura'], 'images': pins}, sort_keys=False))
            (root / 'release-revision.yaml').write_text(yaml.safe_dump({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'velura-api-config'}, 'data': {'RELEASE_REVISION': self.release['revision']}}, sort_keys=False))

    def test_staging_update_isolated_from_production_and_base(self):
        base = Path('deploy/k8s/base/velura/application.yaml')
        base.parent.mkdir(parents=True)
        base.write_text('untouched shared base')
        updated = {'revision': 'b' * 40, 'images': {app: image.split('@')[0] + '@sha256:' + 'f' * 64 for app, image in self.release['images'].items()}}
        release_images.update('staging', updated)
        self.assertEqual(release_images.snapshot('staging'), updated)
        self.assertEqual(release_images.snapshot('production'), self.release)
        self.assertEqual(base.read_text(), 'untouched shared base')

    def test_mutable_or_duplicate_pins_rejected(self):
        path = release_images.ROOT / 'staging/kustomization.yaml'
        data = yaml.safe_load(path.read_text())
        data['images'][0]['newTag'] = 'latest'
        path.write_text(yaml.safe_dump(data))
        with self.assertRaises(ValueError):
            release_images.snapshot('staging')
        del data['images'][0]['newTag']
        data['images'].append(data['images'][0])
        path.write_text(yaml.safe_dump(data))
        with self.assertRaises(ValueError):
            release_images.snapshot('staging')

    def evidence(self):
        release_images.EVIDENCE.parent.mkdir(parents=True)
        release_images.EVIDENCE.write_text(json.dumps({'run_id': 123, 'source_sha': 'c' * 40, 'release': self.release}))
        return {'id': 123, 'repository': {'full_name': release_images.REPOSITORY}, 'path': '.github/workflows/ci.yml', 'event': 'push', 'head_branch': 'develop', 'head_sha': 'c' * 40}

    def test_exact_staging_bundle_and_completed_job_required(self):
        run = self.evidence()
        jobs = {'jobs': [{'name': 'verify-staging', 'conclusion': 'success'}]}
        with patch.object(release_images, 'gh_json', side_effect=[run, jobs]), patch.object(release_images, 'remote_snapshot', return_value=self.release):
            release_images.validate_production()
        jobs['jobs'][0]['conclusion'] = 'failure'
        with patch.object(release_images, 'gh_json', side_effect=[run, jobs]), self.assertRaises(ValueError):
            release_images.validate_production()
        jobs['jobs'][0]['conclusion'] = 'success'
        other = {'revision': 'd' * 40, 'images': self.release['images']}
        with patch.object(release_images, 'gh_json', side_effect=[run, jobs]), patch.object(release_images, 'remote_snapshot', return_value=other), self.assertRaises(ValueError):
            release_images.validate_production()

    def test_foreign_or_pr_verification_cannot_authorize_production(self):
        run = self.evidence()
        run['event'] = 'pull_request'
        with patch.object(release_images, 'gh_json', return_value=run), self.assertRaises(ValueError):
            release_images.validate_production()

    def test_scan_secret_content_and_image_configuration_never_uploaded(self):
        Path('scan-api.json').write_text(json.dumps({'SchemaVersion': 2, 'Metadata': {'ImageConfig': {'Env': ['TOKEN=do-not-publish']}}, 'Results': [{'Target': 'app/config', 'Secrets': [{'RuleID': 'token', 'Severity': 'HIGH', 'Match': 'do-not-publish', 'Code': {'Lines': ['do-not-publish']}, 'StartLine': 2}], 'Vulnerabilities': [{'VulnerabilityID': 'CVE-example', 'Severity': 'CRITICAL', 'PkgName': 'package', 'Description': 'not-in-allowlist'}]}]}))
        Path('sbom-api.json').write_text(json.dumps({'spdxVersion': 'SPDX-2.3', 'packages': [{'SPDXID': 'package-1', 'name': 'package', 'versionInfo': '1.0', 'comment': 'do-not-publish'}], 'annotations': ['do-not-publish']}))
        release_images.sanitize('api')
        scan = Path('diagnostics/scan-api.json').read_text()
        sbom = Path('diagnostics/sbom-api.json').read_text()
        self.assertNotIn('do-not-publish', scan + sbom)
        self.assertIn('CVE-example', scan)
        self.assertEqual(json.loads(sbom)['packages'][0]['versionInfo'], '1.0')

    def test_installer_failure_records_absent_reports_without_fabrication(self):
        with patch.dict(os.environ, {'SCANNER_OUTCOME': 'failure', 'SCAN_OUTCOME': 'skipped'}):
            release_images.sanitize('api')
        status = json.loads(Path('diagnostics/status.json').read_text())
        self.assertEqual(status['scanner'], 'failure')
        self.assertFalse(Path('diagnostics/scan-api.json').exists())
        self.assertFalse(Path('diagnostics/sbom-api.json').exists())

    def test_partial_scan_report_does_not_prevent_sbom_diagnostics(self):
        Path('scan-api.json').write_text('{')
        Path('sbom-api.json').write_text(json.dumps({'spdxVersion': 'SPDX-2.3', 'packages': []}))
        release_images.sanitize('api')
        self.assertFalse(Path('diagnostics/scan-api.json').exists())
        self.assertTrue(Path('diagnostics/sbom-api.json').exists())
        self.assertEqual(json.loads(Path('diagnostics/status.json').read_text())['invalid_reports'], ['scan-api.json'])

    def test_bootstrap_does_not_allow_new_pins_or_removed_evidence(self):
        flux = Path('deploy/k8s/base/flux/git-sync.yaml')
        flux.parent.mkdir(parents=True)
        flux.write_text(yaml.safe_dump({'kind': 'Kustomization', 'metadata': {'name': 'velura-production'}, 'spec': {'suspend': True}}))
        baseline = {path.as_posix(): path.read_text() for path in (release_images.ROOT / 'production').glob('*.yaml')}
        def read_git(command, **kwargs):
            return baseline[command[-1].split(':', 1)[1]]
        with patch.object(release_images.subprocess, 'run', side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)]), patch.object(release_images.subprocess, 'check_output', side_effect=read_git):
            release_images.validate_bootstrap('c' * 40)
        release_images.update('production', {'revision': 'd' * 40, 'images': self.release['images']})
        with patch.object(release_images.subprocess, 'run', side_effect=[SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)]), patch.object(release_images.subprocess, 'check_output', side_effect=read_git), self.assertRaises(ValueError):
            release_images.validate_bootstrap('c' * 40)
        with patch.object(release_images.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), self.assertRaises(ValueError):
            release_images.validate_bootstrap('c' * 40)

    def test_worker_pin_update_never_changes_enablement_or_replicas(self):
        root = Path('deploy/k8s/optional/ai-worker')
        root.mkdir(parents=True)
        for name in ('worker.yaml', 'provision-weights.yaml'):
            (root / name).write_text('spec:\n  replicas: 0\n  image: ghcr.io/royal2005-coder/velura-ai-worker:old\n')
        release = Path('release')
        release.mkdir()
        image = release_images.IMAGE_PREFIX + 'ai-worker@sha256:' + 'e' * 64
        (release / 'image-ai-worker.txt').write_text(image)
        with patch.object(release_images.sys, 'argv', ['release-images.py', 'worker', str(release)]):
            release_images.main()
        for name in ('worker.yaml', 'provision-weights.yaml'):
            resource = yaml.safe_load((root / name).read_text())
            self.assertEqual(resource['spec']['replicas'], 0)
            self.assertEqual(resource['spec']['image'], image)
        self.assertEqual(release_images.snapshot('staging'), self.release)


if __name__ == '__main__':
    unittest.main()
