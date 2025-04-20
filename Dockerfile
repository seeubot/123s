FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

# Create temp directory
RUN mkdir -p temp/history

# Run the bot
CMD ["python", "bot.py"]
