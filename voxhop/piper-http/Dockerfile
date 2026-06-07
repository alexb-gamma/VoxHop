FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for Piper + curl for healthcheck
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Install Piper TTS binary
# Note: Piper binary is baked into the AMI at /usr/local/bin/piper
# For Docker, we download it here
ARG PIPER_VERSION=2023.11.14-2
RUN wget -q "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    -O /tmp/piper.tar.gz && \
    tar -xzf /tmp/piper.tar.gz -C /usr/local/bin --strip-components=1 && \
    rm /tmp/piper.tar.gz && \
    chmod +x /usr/local/bin/piper

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application
COPY main.py .

# Model directory (models are mounted or baked in AMI)
RUN mkdir -p /models

EXPOSE 5000

ENV PIPER_MODEL=/models/en_GB-alan-medium.onnx
ENV PIPER_BIN=/usr/local/bin/piper
# Piper tarball extracts libs and espeak-ng-data alongside the binary
ENV LD_LIBRARY_PATH=/usr/local/bin
ENV ESPEAK_DATA_PATH=/usr/local/bin/espeak-ng-data

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "1"]
