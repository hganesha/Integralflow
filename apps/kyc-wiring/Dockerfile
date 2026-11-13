FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt requirements-tested.txt ./
RUN pip install --no-cache-dir -r requirements.txt -c requirements-tested.txt && useradd --uid 10001 --create-home wiring
COPY --chown=wiring:wiring . /app
RUN mkdir -p /app/.local && chown -R wiring:wiring /app/.local
USER wiring
EXPOSE 8000
CMD ["uvicorn", "wiring.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
