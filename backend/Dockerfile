# SiteMate API and worker (one image, two commands). Build from the repository root:
#   docker build -f backend/Dockerfile -t sitemate-backend .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# Dependencies first (cached): backend/requirements.txt includes ../ai-agent/requirements.txt.
COPY ai-agent/requirements.txt ai-agent/requirements.txt
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY ai-agent ai-agent
COPY backend backend
# The Riverside demo pack and the reference plan PDFs are read-only inputs.
COPY data data
COPY mock_data mock_data

RUN useradd --create-home --uid 10001 sitemate && mkdir -p /app/backend/storage && chown -R sitemate /app/backend/storage
USER sitemate
WORKDIR /app/backend
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
