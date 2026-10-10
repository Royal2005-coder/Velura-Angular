# Pass a reviewed python:3.11-slim-bookworm@sha256:<registry digest> at build time.
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE} AS dependencies
WORKDIR /build
COPY apps/ai-worker/requirements-production.txt ./requirements-production.txt
RUN python -m pip wheel --only-binary=:all: --wheel-dir=/wheels -r requirements-production.txt
COPY apps/ai-worker/vendor_sources.py ./vendor_sources.py
RUN python vendor_sources.py --destination=/vendor

FROM ${PYTHON_IMAGE} AS runtime
ARG RELEASE_REVISION
LABEL org.opencontainers.image.title="Velura private licensed image worker" \
      org.opencontainers.image.revision="${RELEASE_REVISION}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app:/opt/vendor AI_WEIGHTS_DIR=/weights \
    HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib HOME=/tmp
COPY --from=dependencies /wheels /wheels
COPY apps/ai-worker/requirements-production.txt /opt/requirements-production.txt
RUN python -m pip install --no-index --find-links=/wheels -r /opt/requirements-production.txt \
    && python -m pip freeze --all > /opt/installed-requirements.txt \
    && rm -rf /wheels \
    && groupadd --gid 1000 worker \
    && useradd --uid 1000 --gid 1000 --no-create-home worker \
    && mkdir /app /weights \
    && chown worker:worker /app /weights
COPY --from=dependencies /vendor /opt/vendor
WORKDIR /app
COPY apps/ai-worker/production_*.py apps/ai-worker/maskless_vton.py \
     apps/ai-worker/image_gate.py apps/ai-worker/bootstrap_weights.py \
     apps/ai-worker/weights-manifest.json ./
USER 1000:1000
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "production_service:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--timeout-keep-alive", "5", "--limit-concurrency", "8"]
