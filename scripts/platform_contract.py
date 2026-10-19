"""Reject platform manifests that cannot admit their own deployment rollouts."""

from collections import defaultdict
from decimal import Decimal
from math import ceil
import re


def quantity(value):
    """Compare Kubernetes CPU and memory quantities without rounding away limits."""
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|m)?", str(value))
    if not match:
        raise ValueError(f"Unsupported resource quantity: {value}")
    scale = {None: 1, "Ki": 1024, "Mi": 1024**2, "Gi": 1024**3,
             "Ti": 1024**4, "k": 1000, "M": 1000**2, "G": 1000**3,
             "m": Decimal("0.001")}
    return Decimal(match[1]) * scale[match[2]]


def validate_platform(objects):
    """Require valid pod fields and namespace headroom for concurrent rollouts."""
    budgets = {}
    defaults = {}
    demand = defaultdict(lambda: defaultdict(Decimal))
    for obj in objects:
        namespace = obj.get("metadata", {}).get("namespace", "default")
        if obj.get("kind") == "ResourceQuota":
            budgets[namespace] = obj["spec"]["hard"]
        if obj.get("kind") == "LimitRange":
            for limit in obj["spec"]["limits"]:
                if limit["type"] == "Container":
                    defaults[namespace] = limit

    for obj in objects:
        if obj.get("kind") != "Deployment":
            continue
        namespace = obj["metadata"]["namespace"]
        name = obj["metadata"]["name"]
        spec = obj["spec"]
        replicas = spec.get("replicas", 1)
        strategy = spec.get("strategy", {})
        surge = 0
        if replicas and strategy.get("type", "RollingUpdate") == "RollingUpdate":
            value = strategy.get("rollingUpdate", {}).get("maxSurge", "25%")
            surge = ceil(replicas * int(value[:-1]) / 100) if isinstance(value, str) and value.endswith("%") else int(value)
        count = replicas + surge
        demand[namespace]["pods"] += count
        for container in spec["template"]["spec"]["containers"]:
            args = container.get("args", [])
            image = container.get("image", "")
            if "chrislusf/seaweedfs:" in image and "server" in args and "-s3" in args and "-filer" not in args:
                raise ValueError(f"{namespace}/{name}: embedded S3 requires -filer")
            if "victoriametrics/victoria-metrics:" in image:
                for arg in args:
                    if arg.startswith("-memory.allowedBytes=") and not arg.split("=", 1)[1].isdigit():
                        raise ValueError(f"{namespace}/{name}: memory.allowedBytes must use an explicit byte count")
            for env in container.get("env", []):
                if "value" in env and "valueFrom" in env:
                    raise ValueError(f"{namespace}/{name}: env {env['name']} has both value and valueFrom")
            for probe in ("readinessProbe", "livenessProbe", "startupProbe"):
                if probe in container:
                    handlers = {"exec", "tcpSocket", "httpGet", "grpc"}.intersection(container[probe])
                    if len(handlers) != 1:
                        raise ValueError(f"{namespace}/{name}: {probe} requires exactly one handler")
            resources = container.get("resources", {})
            default = defaults.get(namespace, {})
            for resource in ("memory", "cpu"):
                explicit_limit = resources.get("limits", {}).get(resource)
                limit = explicit_limit or default.get("default", {}).get(resource)
                request = resources.get("requests", {}).get(resource, explicit_limit or default.get("defaultRequest", {}).get(resource))
                for category, value in (("limits", limit), ("requests", request)):
                    if value is not None:
                        demand[namespace][f"{category}.{resource}"] += count * quantity(value)
    for namespace, hard in budgets.items():
        for resource, needed in demand[namespace].items():
            if resource in hard and needed > quantity(hard[resource]):
                raise ValueError(f"{namespace}: rollout needs {resource}={needed}, quota permits {hard[resource]}")
