"""Regression coverage for the admission failures found during Flux adoption."""

import unittest
from platform_contract import validate_platform


def workload(strategy="RollingUpdate", memory="768Mi"):
    return {"kind": "Deployment", "metadata": {"name": "identity", "namespace": "auth"},
            "spec": {"replicas": 1, "strategy": {"type": strategy},
                     "template": {"spec": {"containers": [{"name": "identity", "resources": {
                         "requests": {"memory": "384Mi"}, "limits": {"memory": memory}}}]}}}}


class PlatformContractTests(unittest.TestCase):
    def test_gateway_config_updates_are_wired_into_the_pod_template(self):
        obj = workload()
        obj['metadata']['name'] = 'litellm'
        obj['spec']['template']['spec']['volumes'] = [{'name': 'config', 'configMap': {'name': 'litellm-config'}}]
        with self.assertRaisesRegex(ValueError, 'generated hash-named'):
            validate_platform([obj])
        name = 'litellm-config-1234567890'
        obj['spec']['template']['spec']['volumes'][0]['configMap']['name'] = name
        config = {'kind': 'ConfigMap', 'metadata': {'namespace': 'auth', 'name': name}}
        validate_platform([obj, config])

    def test_embedded_s3_requires_a_running_filer(self):
        obj = workload()
        container = obj["spec"]["template"]["spec"]["containers"][0]
        container.update(image="chrislusf/seaweedfs:3.85", args=["server", "-s3"])
        with self.assertRaisesRegex(ValueError, "requires -filer"):
            validate_platform([obj])
        container["args"].append("-filer")
        validate_platform([obj])

    def test_victoriametrics_does_not_accept_kubernetes_memory_suffix(self):
        obj = workload()
        container = obj["spec"]["template"]["spec"]["containers"][0]
        container.update(image="victoriametrics/victoria-metrics:v1.104.0", args=["-memory.allowedBytes=384Mi"])
        with self.assertRaisesRegex(ValueError, "explicit byte count"):
            validate_platform([obj])
        container["args"] = ["-memory.allowedBytes=402653184"]
        validate_platform([obj])

    def test_quota_must_admit_replacement_while_serving(self):
        quota = {"kind": "ResourceQuota", "metadata": {"namespace": "auth"},
                 "spec": {"hard": {"limits.memory": "1Gi"}}}
        with self.assertRaisesRegex(ValueError, "rollout needs"):
            validate_platform([quota, workload()])
        quota["spec"]["hard"]["limits.memory"] = "2Gi"
        validate_platform([quota, workload()])

    def test_recreate_does_not_reserve_a_concurrent_database(self):
        quota = {"kind": "ResourceQuota", "metadata": {"namespace": "auth"},
                 "spec": {"hard": {"limits.memory": "1Gi"}}}
        validate_platform([quota, workload("Recreate")])

    def test_conflicting_probe_handlers_fail_before_cluster_apply(self):
        obj = workload()
        obj["spec"]["template"]["spec"]["containers"][0]["livenessProbe"] = {
            "exec": {"command": ["true"]}, "tcpSocket": {"port": 5432}}
        with self.assertRaisesRegex(ValueError, "exactly one handler"):
            validate_platform([obj])

    def test_env_cannot_mix_a_literal_with_a_secret(self):
        obj = workload()
        obj["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {"name": "KC_DB_PASSWORD", "value": None, "valueFrom": {"secretKeyRef": {"name": "db", "key": "password"}}}]
        with self.assertRaisesRegex(ValueError, "both value and valueFrom"):
            validate_platform([obj])


if __name__ == "__main__":
    unittest.main()
