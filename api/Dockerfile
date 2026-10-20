FROM python:3.12.10-slim
WORKDIR /app
COPY requirements.lock pyproject.toml alembic.ini VERSION ./
COPY api ./api
COPY catalog ./catalog
# The starter decks, the same lists as the engine's fixture decks.
COPY engine/decks ./starters
ENV CD_STARTER_DECKS_DIR=/app/starters
RUN pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps .
# The card image cache and the catalog's bulk files; named volumes mounted here start with this owner.
RUN install -d -o 10001 -g 10001 /var/lib/commander-duels/card-images /var/lib/commander-duels/catalog
USER 10001:10001
EXPOSE 8000
# The API resolves client addresses itself, from CD_TRUSTED_PROXIES only.
# WebSocket messages are small JSON commands; 64 KiB is plenty.
CMD ["uvicorn", "api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--ws-max-size", "65536"]
