FROM python:3.12-alpine

WORKDIR /app
COPY server.py index.html core.js ui.js ./

# High scores are stored in SQLite; mount a volume at /data to keep them.
ENV POLYPIT_DB=/data/polypit.db PORT=8000
RUN mkdir -p /data
VOLUME /data

EXPOSE 8000
CMD ["python", "server.py"]
