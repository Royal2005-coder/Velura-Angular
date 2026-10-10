"""Run real inference checks on upstream samples, not customer photos or public studio assets."""
import json
from pathlib import Path
import shutil
import subprocess
import time
import os

ROOT = Path('/content/velura-ai')
PYTHON = str(ROOT / '.venv/bin/python')
installed = subprocess.run(['uv', 'pip', 'install', '--python', PYTHON, 'rembg==2.0.61',
                'av==12.3.0', 'cloudpickle==3.1.1', 'psutil==7.1.0', 'pandas==2.2.3'],
                capture_output=True, text=True)
(ROOT / 'verification-install.log').write_text(installed.stdout + installed.stderr)
if installed.returncode:
    print((installed.stdout + installed.stderr)[-5000:])
    raise RuntimeError('VERIFICATION_DEPENDENCIES_FAILED')
summary_path = ROOT / 'verification-summary.json'
summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
for task in os.environ.get('AI_VERIFY_TASKS', 'image_quality,image_embedding,product_image_enhance,virtual_try_on').split(','):
    directory = ROOT / 'verification' / task
    directory.mkdir(parents=True, exist_ok=True)
    sample = os.environ.get('AI_VERIFY_PERSON', '01350_00.jpg')
    if sample not in {'01350_00.jpg', '01376_00.jpg', '01416_00.jpg', '05976_00.jpg', '06094_00.jpg'}:
        raise ValueError('INVALID_VERIFICATION_SAMPLE')
    shutil.copyfile(ROOT / 'Leffa/ckpts/examples/person1' / sample, directory / 'person.png')
    shutil.copyfile(ROOT / 'Leffa/ckpts/examples/garment/01449_00.jpg', directory / 'garment.png')
    job = {'task': task, 'image': 'garment.png', 'person': 'person.png', 'garment': 'garment.png',
           'mode': 'personal', 'garment_category': 'upper_body', 'consent': True, 'confirmed': True,
           'options': {'background': 'white'}}
    (directory / 'job.json').write_text(json.dumps(job))
    # A killed subprocess must never reuse the previous attempt's success or validation result.
    (directory / 'result.json').unlink(missing_ok=True)
    (directory / 'result.png').unlink(missing_ok=True)
    started = time.monotonic()
    try:
        completed = subprocess.run([PYTHON, str(ROOT / 'infer.py'), str(directory)],
                                   capture_output=True, text=True, timeout=900)
        (directory / 'private-inference.log').write_text(completed.stdout + completed.stderr)
        if completed.returncode:
            raise RuntimeError(f'WORKER_EXIT_{completed.returncode}')
        result = json.loads((directory / 'result.json').read_text())
        summary[task] = {key: value for key, value in result.items() if key != 'embedding'}
        summary[task]['elapsed_seconds'] = round(time.monotonic() - started, 2)
        if result.get('embedding'):
            summary[task]['vector_length'] = len(result['embedding'])
    except Exception as error:
        summary[task] = {'status': 'failed', 'error': str(error)}
    (ROOT / 'verification-summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({task: summary[task]}), flush=True)
