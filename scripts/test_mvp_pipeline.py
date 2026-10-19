"""Production-only release invariants for the reviewed main/Flux workflow."""
from pathlib import Path
import json
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class MvpPipelineTests(unittest.TestCase):
    def test_fast_mvp_keeps_ci_gates_without_mandatory_approval(self):
        policy = json.loads((ROOT / '.github/branch-protection.json').read_text())
        reviews = policy['required_pull_request_reviews']
        self.assertEqual(reviews['required_approving_review_count'], 0)
        self.assertFalse(reviews['require_code_owner_reviews'])
        self.assertTrue(policy['enforce_admins'])
        self.assertTrue(policy['required_status_checks']['strict'])
        self.assertEqual(len(policy['required_status_checks']['checks']), 9)

    def test_no_staging_job_or_environment_is_required(self):
        jobs = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text(encoding='utf-8'))['jobs']
        self.assertNotIn('verify-staging', jobs)
        self.assertNotIn('promote-production', jobs)
        for job in jobs.values():
            self.assertNotEqual(job.get('environment'), 'staging')
            self.assertNotIn('verify-staging', job.get('needs', []))
        for name in ('manifests', 'verify-production'):
            commands = '\n'.join(step.get('run', '') for step in jobs[name]['steps'])
            self.assertIn('cosign verify', commands)

    def test_root_owns_flux_configuration_without_child_health_deadlock(self):
        resources = list(yaml.safe_load_all((ROOT / 'deploy/k8s/base/flux/git-sync.yaml').read_text(encoding='utf-8')))
        owners = {item['metadata']['name']: item for item in resources}
        self.assertNotIn('velura-staging', owners)
        self.assertNotIn('velura-staging-repo', owners)
        self.assertEqual(owners['velura-repo']['spec']['ref']['branch'], 'main')
        self.assertFalse(owners['velura-root']['spec']['wait'])
        self.assertEqual(owners['velura-root']['spec']['path'], './deploy/k8s/clusters/production')
        self.assertTrue(owners['velura-infra']['spec']['wait'])
        self.assertEqual(owners['velura-production']['spec']['dependsOn'], [{'name': 'velura-infra'}])


if __name__ == '__main__':
    unittest.main()
