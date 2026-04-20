FROM python:3.12-slim

# Install system dependencies for OpenCV and MediaPipe
# libgl1-mesa-glx and libglib2.0-0 are required by cv2
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first to leverage Docker cache
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all source code and model files from the cmd/ai-server directory
COPY . .

# Expose the FastAPI port
EXPOSE 8000

# Set environment variables for reproducibility
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Run the server
CMD ["python", "main.py"]
