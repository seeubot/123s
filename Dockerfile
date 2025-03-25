# Dockerfile
FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY terabox_scraper.py .

# Expose the port the app runs on
EXPOSE 8000

# Run the application
CMD ["uvicorn", "terabox_scraper:app", "--host", "0.0.0.0", "--port", "8000"]
