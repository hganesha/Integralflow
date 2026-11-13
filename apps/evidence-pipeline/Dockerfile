# kyc-evidence-server: the evidence pipeline's authenticated HTTP API (src/kyc_pipeline/server.py).
FROM python:3.13-slim
ENV PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 EVIDENCE_PIPELINE_DATA_DIR=/data
WORKDIR /app
COPY requirements-runtime.lock /app/requirements-runtime.lock
RUN python -m pip install --no-cache-dir -r requirements-runtime.lock
COPY pyproject.toml README.md /app/
COPY src /app/src
RUN python -m pip install --no-deps --no-cache-dir . && mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
CMD ["kyc-evidence-server"]
