FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir openai websockets
COPY bot.py mapper.py tutorial.py ./
CMD ["python", "bot.py"]
