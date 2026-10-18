FROM python:3.12.10-slim
WORKDIR /app
COPY requirements.lock pyproject.toml alembic.ini ./
COPY api ./api
COPY catalog ./catalog
RUN pip install --no-cache-dir -r requirements.lock && pip install --no-cache-dir --no-deps .
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
