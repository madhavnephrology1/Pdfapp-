# syntax=docker/dockerfile:1

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY apps/api/pyproject.toml ./
# Installing from the manifest alone first keeps the dependency layer cached.
RUN pip install --upgrade pip && pip install .

COPY apps/api/app ./app

# The API never needs root at runtime, and temporary files are owner-only.
RUN useradd --create-home --uid 10001 reader \
    && mkdir -p /app/tmp \
    && chown -R reader:reader /app
USER reader

ENV TEMP_FILE_DIRECTORY=/app/tmp

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
