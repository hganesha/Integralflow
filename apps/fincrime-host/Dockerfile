FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54
ENV PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements-runtime.lock /app/requirements-runtime.lock
RUN python -m pip install --no-cache-dir -r requirements-runtime.lock
COPY pyproject.toml /app/
COPY src /app/src
RUN python -m pip install --no-deps --no-cache-dir . && mkdir -p /app/config /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8090
# skill.execution.v1 host; requires SKILL_HOST_AUTH_TOKEN (>= 16 chars). See README.
CMD ["python", "-m", "kyc_document_studio"]
