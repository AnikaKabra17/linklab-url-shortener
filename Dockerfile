# LinkLab — one container: FastAPI API + web UI + redirects + in-memory SQLite.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

WORKDIR /srv

RUN useradd --create-home --uid 10001 appuser

# Dependencies first so this layer is cached between code changes.
COPY requirements.txt .
RUN pip install -r requirements.txt

# Application code and static frontend assets (app/static/*).
COPY app/ ./app/

USER appuser
EXPOSE 8000

# Real readiness check: /health runs a query against the in-memory database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT', '8000'), timeout=2)"

# Exactly ONE worker process: the in-memory database lives inside that process,
# so multiple workers would each have their own, different set of links.
# `exec` makes Uvicorn PID 1 so it receives SIGTERM and shuts down cleanly.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
