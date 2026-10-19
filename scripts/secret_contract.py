"""Static ciphertext gates; decryption/MAC verification belongs to the operator and Flux."""

from pathlib import Path
import re
import yaml


def validate_secret(resource, filename, recipients, encrypted_regex):
    """Reject clear Secret values or recipient drift without logging credential content."""
    if resource.get('kind') != 'Secret':
        return
    if not str(filename).endswith('.enc.yaml'):
        raise ValueError(f'{filename}: Secret manifests must use .enc.yaml')
    if 'kubectl.kubernetes.io/last-applied-configuration' in resource.get('metadata', {}).get('annotations', {}):
        raise ValueError(f'{filename}: last-applied annotation can leak Secret payloads; remove it before encryption')
    metadata = resource.get('sops', {})
    actual_recipients = {entry.get('recipient') for entry in metadata.get('age', [])}
    if actual_recipients != set(recipients) or not actual_recipients:
        raise ValueError(f'{filename}: SOPS recipients differ from the matching creation rule')
    if metadata.get('encrypted_regex') != encrypted_regex or not metadata.get('mac', '').startswith('ENC[AES256_GCM,'):
        raise ValueError(f'{filename}: missing SOPS encryption/MAC metadata')
    for field in ('data', 'stringData'):
        values = resource.get(field, {})
        if not isinstance(values, dict):
            raise ValueError(f'{filename}: Secret payload must be a mapping')
        for value in values.values():
            if not isinstance(value, str) or (value and not value.startswith('ENC[AES256_GCM,')):
                raise ValueError(f'{filename}: Secret contains a non-encrypted value; content withheld')


def validate_secret_files(root=Path('deploy/k8s'), config_path=Path('.sops.yaml')):
    """Check all Secret source files, including encrypted snapshots not yet activated."""
    rules = yaml.safe_load(config_path.read_text(encoding='utf-8'))['creation_rules']
    for path in root.rglob('*.yaml'):
        try:
            resources = list(yaml.safe_load_all(path.read_text(encoding='utf-8')))
        except yaml.YAMLError:
            raise ValueError(f'{path}: invalid YAML; content withheld') from None
        for resource in resources:
            if not resource or resource.get('kind') != 'Secret':
                continue
            rule = next((rule for rule in rules if re.search(rule['path_regex'], path.as_posix())), None)
            if not rule:
                raise ValueError(f'{path}: Secret has no matching SOPS creation rule')
            recipients = [value.strip() for value in rule['age'].split(',') if value.strip()]
            validate_secret(resource, path, recipients, rule['encrypted_regex'])
