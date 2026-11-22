# Local, OpenAI-compatible speech-to-text (faster-whisper). docker build -t sitemate-whisper backend/whisper-server
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py .
RUN useradd --create-home --uid 10001 whisper
USER whisper
EXPOSE 8001
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8001"]
