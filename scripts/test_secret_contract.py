"""Guard against plaintext/base64 credentials being committed as Kubernetes Secrets."""

from copy import deepcopy
import unittest
from secret_contract import validate_secret


class SecretContractTests(unittest.TestCase):
    def setUp(self):
        self.resource = {'kind': 'Secret', 'data': {'password': 'ENC[AES256_GCM,test-fixture]'},
                         'sops': {'age': [{'recipient': 'age1cluster'}, {'recipient': 'age1recovery'}],
                                  'encrypted_regex': '^(data|stringData)$', 'mac': 'ENC[AES256_GCM,test-fixture]'}}

    def validate(self, resource, path='deploy/k8s/base/secrets/db.enc.yaml'):
        validate_secret(resource, path, ['age1cluster', 'age1recovery'], '^(data|stringData)$')

    def test_ciphertext_with_matching_recovery_recipient_is_accepted(self):
        self.validate(self.resource)

    def test_base64_is_not_encryption(self):
        resource = deepcopy(self.resource)
        resource['data']['password'] = 'bm90LWEtcmVhbC1jcmVkZW50aWFs'
        with self.assertRaisesRegex(ValueError, 'non-encrypted'):
            self.validate(resource)

    def test_clear_string_data_is_rejected_even_with_encrypted_data(self):
        resource = deepcopy(self.resource)
        resource['stringData'] = {'another-key': 'test-fixture-not-a-secret'}
        with self.assertRaisesRegex(ValueError, 'non-encrypted'):
            self.validate(resource)

    def test_recipient_changes_require_a_creation_rule_change(self):
        resource = deepcopy(self.resource)
        resource['sops']['age'].append({'recipient': 'age1unapproved'})
        with self.assertRaisesRegex(ValueError, 'recipients differ'):
            self.validate(resource)

    def test_plain_yaml_secret_filename_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '.enc.yaml'):
            self.validate(self.resource, 'deploy/k8s/base/secrets/db.yaml')

    def test_kubectl_annotation_cannot_smuggle_unencrypted_payloads(self):
        resource = deepcopy(self.resource)
        resource['metadata'] = {'annotations': {'kubectl.kubernetes.io/last-applied-configuration': '{}'}}
        with self.assertRaisesRegex(ValueError, 'last-applied annotation'):
            self.validate(resource)


if __name__ == '__main__':
    unittest.main()
