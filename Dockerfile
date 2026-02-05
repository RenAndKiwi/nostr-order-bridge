FROM node:20-slim

WORKDIR /app

COPY server.js index.html ./

RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 3848

CMD ["node", "server.js"]
