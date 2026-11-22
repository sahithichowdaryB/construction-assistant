# The agent worker: claims agent_jobs (reasoning, action planning, daily and overall evaluation, auto-drafts, document
# ingestion, daily reports). It imports the backend modules, so it is the backend image with the worker command.
# Build from the repository root:  docker build -f ai-agent/Dockerfile -t sitemate-worker .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY ai-agent/requirements.txt ai-agent/requirements.txt
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt
COPY ai-agent ai-agent
COPY backend backend
COPY data data
COPY mock_data mock_data
RUN useradd --create-home --uid 10001 sitemate && mkdir -p /app/backend/storage && chown -R sitemate /app/backend/storage
USER sitemate
WORKDIR /app/backend
CMD ["python", "worker.py"]
