# Python 3.11 — akshare wheels available
FROM python:3.11-slim

# System deps for pandas/numpy wheels + tini for clean signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000

# Railway injects $PORT — uvicorn reads it via main.py
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "main.py"]
