"""OmegaConf stand-in for the vendored TripoSR tree: the calls it actually makes, no sdist-only dependency.

Upstream `tsr` reads its architecture with `OmegaConf.load/resolve/structured/merge`. omegaconf pins
`antlr4-python3-runtime==4.9.3`, which publishes no wheel, so it cannot enter an image built with
`pip wheel --only-binary=:all:`. Reimplementing the used surface keeps the worker free of a compiler
step and of an unmaintained parser runtime.

Validation is intentionally as strict as OmegaConf was here: a key a module never reads, or a field
with no default that the file does not supply, fails the job rather than silently changing the
architecture that `model.ckpt` was trained against.
"""

import dataclasses
import re

REFERENCE = re.compile(r"^\$\{([^}]+)\}$")
REQUIRED = object()


class Config(dict):
    """Mapping with attribute access, which is how every vendored module reads its settings.

    Nested blocks are wrapped too, so `cfg.renderer.radius` works wherever a Config was built from.
    """

    def __init__(self, mapping=None, **extra):
        super().__init__()
        for key, value in {**(mapping or {}), **extra}.items():
            self[key] = _wrap(value)

    def __getattr__(self, name: str):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


DictConfig = Config


class Schema:
    """Field names and defaults of a module's config dataclass, carried into merge for validation."""

    def __init__(self, fields: dict):
        self.fields = fields


def load(path: str) -> Config:
    """Parse the publisher's architecture file into attribute-readable settings."""
    import yaml

    with open(path, encoding="utf-8") as stream:
        return _wrap(yaml.safe_load(stream))


def resolve(root: Config) -> Config:
    """Substitute `${dotted.path}` references in place, the only interpolation config.yaml uses."""

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                node[key] = walk(value)
            return node
        reference = REFERENCE.match(node) if isinstance(node, str) else None
        if reference is None:
            return node
        target = root
        for part in reference.group(1).split("."):
            target = target[part]
        return target

    walk(root)
    return root


def structured(schema) -> Schema:
    """Declared fields of a config dataclass; anything else carries no constraints."""
    if not dataclasses.is_dataclass(schema):
        return Schema({})
    fields = {}
    for field in dataclasses.fields(schema):
        if field.default is not dataclasses.MISSING:
            fields[field.name] = field.default
        elif field.default_factory is not dataclasses.MISSING:
            fields[field.name] = field.default_factory()
        else:
            fields[field.name] = REQUIRED
    return Schema(fields)


def merge(base, override) -> Config:
    """Reject keys the module never reads and require every field that has no default."""
    if isinstance(base, Schema):
        known = base.fields
    elif dataclasses.is_dataclass(base):
        known = structured(base).fields
    else:
        known = dict(base or {})
    provided = dict(override or {})
    unknown = sorted(set(provided) - set(known))
    if unknown:
        raise ValueError(f"CONFIG_UNKNOWN_FIELD:{unknown[0]}")
    for name, default in known.items():
        if default is REQUIRED and name not in provided:
            raise ValueError(f"CONFIG_MISSING_FIELD:{name}")
    return _wrap({name: provided.get(name, default) for name, default in known.items()})


def _wrap(value):
    if isinstance(value, dict):
        return Config({key: _wrap(item) for key, item in value.items()})
    if isinstance(value, list):
        return [_wrap(item) for item in value]
    return value


class OmegaConf:
    """The static methods the vendored tree calls, named identically so each patch stays one line."""

    load = staticmethod(load)
    resolve = staticmethod(resolve)
    structured = staticmethod(structured)
    merge = staticmethod(merge)
