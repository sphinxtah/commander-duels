from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.responses import Response

from api import (
    admin,
    auth,
    card_images,
    cards,
    custom_cards,
    decks,
    economy,
    engine_cards,
    games,
    progression,
)
from api.config import Settings
from api.database import build_engine, migration_head
from api.google import CachingTransport, GoogleVerifier
from api.identity import SAFE_METHODS, ApiError, add_rotated_cookie
from api.schemas import (
    AuthConfig,
    Bootstrap,
    Capability,
    EngineStatus,
    Error,
    Format,
    Health,
    Readiness,
)
from api.version import APP_VERSION

CAPABILITIES = [
    Capability(
        id="catalog",
        name="Card catalog",
        available=True,
        milestone="M1",
        reason="Scryfall's cards, imported daily; each says whether the game engine can play it.",
    ),
    Capability(
        id="decks",
        name="Deck builder",
        available=True,
        milestone="M1",
        reason="Commander and Legacy decks, validated by the server and playable at the practice "
        "table since v0.2.0.",
    ),
    Capability(
        id="gameplay",
        name="Practice play",
        available=True,
        milestone="M0–M3",
        reason="Practice games against bots are playable in the browser since v0.1.0. Human "
        "opponents, lobbies and recovery come later.",
    ),
    Capability(
        id="alliance",
        name="Planeswalker Alliance",
        available=True,
        milestone="M4",
        reason="Wins raise your level, which opens Planeswalkers to ally with; an alliance brings "
        "its Planeswalker's cards into your library (v0.3.1).",
    ),
    Capability(
        id="campaign",
        name="Campaign and lessons",
        milestone="M4",
        reason="Reference audit and authorized scenario content are outstanding.",
    ),
    Capability(
        id="offline",
        name="Offline practice",
        milestone="M5",
        reason="Browser-local rules and AI execution have not been demonstrated.",
    ),
]


def authentication(config: Settings) -> Capability:
    configured = bool(config.google_client_id)
    return Capability(
        id="authentication",
        name="Google sign-in",
        available=configured,
        milestone="M1",
        reason="Google sign-in is available."
        if configured
        else "Google sign-in needs a Web OAuth client ID in CD_GOOGLE_CLIENT_ID.",
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or Settings()
    expected_revision = migration_head()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.database = build_engine(config.database_url)
        token = config.engine_service_token.get_secret_value()
        with httpx.Client(timeout=5.0) as google:
            if config.google_client_id:
                app.state.google_verifier = GoogleVerifier(
                    config.google_client_id, CachingTransport(google)
                )
            async with (
                httpx.AsyncClient(timeout=2.0, trust_env=False) as client,
                httpx.AsyncClient(
                    timeout=10.0,
                    trust_env=False,
                    transport=getattr(app.state, "engine_transport", None),
                ) as engine_client,
                httpx.AsyncClient(
                    timeout=10.0,
                    trust_env=False,
                    follow_redirects=False,
                    transport=getattr(app.state, "scryfall_transport", None),
                ) as scryfall,
            ):
                app.state.http = client
                app.state.scryfall = scryfall
                app.state.card_images = card_images.CardImageCache(
                    config, app.state.database, scryfall
                )
                engine = (
                    games.EngineClient(str(config.engine_url), token, engine_client)
                    if token
                    else None
                )
                app.state.games = games.GameHub(config, app.state.database, engine)
                # Which custom cards the running engine has loaded (v0.4.0).
                app.state.engine_cards = engine_cards.EngineCards(engine)
                await app.state.games.start()
                try:
                    yield
                finally:
                    await app.state.games.stop()
        app.state.database.dispose()

    app = FastAPI(
        title="Commander Duels",
        version=APP_VERSION,
        lifespan=lifespan,
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        redoc_url=None,
        responses={503: {"model": Error}},
    )
    app.state.settings = config
    allowed_origins = config.allowed_origins

    @app.middleware("http")
    async def same_origin(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Browsers send Origin with every state-changing fetch. Another site's requests stop here,
        # before any cookie is looked at (CSRF defence in depth; sessions also need a token).
        if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if (origin and origin not in allowed_origins) or request.headers.get(
                "sec-fetch-site"
            ) == "cross-site":
                return error_response(
                    request, 403, "origin_refused", "Requests from other sites are refused."
                )
        return await call_next(request)

    @app.middleware("http")
    async def correlation(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = str(uuid4())
        response = await call_next(request)
        # Here, not in the route: FastAPI drops a dependency's cookies from error responses and
        # from routes that return their own Response, which would sign the player out.
        add_rotated_cookie(request, response)
        response.headers["X-Request-ID"] = request.state.request_id
        # Only a route that sets its own caching (card images) keeps it.
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def error_response(
        request: Request, status: int, code: str, message: str, names: list[str] | None = None
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status,
            content=Error(
                code=code, message=message, request_id=request.state.request_id, names=names
            ).model_dump(exclude_none=True),
        )

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError) -> JSONResponse:
        response = error_response(request, exc.status, exc.code, exc.message, exc.names)
        response.headers.update(exc.headers or {})
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return error_response(request, exc.status_code, f"http_{exc.status_code}", str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(
            request, 422, "invalid_request", "Request does not match the API contract."
        )

    # A bug's 500. Starlette answers it outside every middleware and then re-raises it for the
    # server's log, so this response gets correlation's work here: the request ID, the headers and
    # a cookie rotated before the failure, without which the player would be signed out.
    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        if not hasattr(request.state, "request_id"):
            request.state.request_id = str(uuid4())
        response = error_response(
            request, 500, "internal_error", "Something went wrong on the server."
        )
        add_rotated_cookie(request, response)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/v1/health", response_model=Health)
    def health() -> Health:
        return Health()

    @app.get("/api/v1/ready", response_model=Readiness, responses={503: {"model": Readiness}})
    def ready(request: Request, response: Response) -> Readiness:
        state = "unavailable"
        try:
            with request.app.state.database.connect() as connection:
                connection.execute(text("SELECT 1"))
                state = "migration_required"
                revision = connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar()
                if revision == expected_revision:
                    return Readiness(status="ready", database="ready")
        except SQLAlchemyError:
            pass
        response.status_code = 503
        return Readiness(status="not_ready", database=state)  # type: ignore[arg-type]

    @app.get("/api/v1/bootstrap", response_model=Bootstrap)
    def bootstrap() -> Bootstrap:
        return Bootstrap(
            capabilities=[authentication(config), *CAPABILITIES],
            auth=AuthConfig(
                google_client_id=config.google_client_id or None,
                signup_policy=config.signup_policy,
            ),
        )

    @app.get("/api/v1/formats", response_model=list[Format])
    def formats() -> list[Format]:
        # Practice games against the bots play Commander and Legacy (games.FIXTURE_DECKS).
        return [
            Format(
                id="commander",
                name="Commander",
                seats=[2, 3, 4],
                default_seats=4,
                description="Build around your commander. A shared table, a singular strategy.",
                available=True,
            ),
            Format(
                id="legacy",
                name="Legacy",
                seats=[2],
                default_seats=2,
                description="Two players. Deep card history. Your next decisive play.",
                available=True,
            ),
            Format(
                id="two_headed_giant",
                name="Two-Headed Giant",
                seats=[4],
                default_seats=4,
                description="Two teams of two. Plan together and share the victory.",
            ),
        ]

    @app.get("/api/v1/engine/status", response_model=EngineStatus)
    async def engine_status(request: Request) -> EngineStatus:
        try:
            response = await request.app.state.http.get(
                f"{str(config.engine_url).rstrip('/')}/health"
            )
            response.raise_for_status()
            return EngineStatus.model_validate(response.json())
        except (httpx.HTTPError, ValueError):
            return EngineStatus(status="unavailable")

    app.include_router(auth.router)
    app.include_router(admin.router)
    app.include_router(games.router)
    app.include_router(card_images.router)
    app.include_router(cards.router)
    app.include_router(decks.router)
    app.include_router(progression.router)
    app.include_router(custom_cards.router)
    app.include_router(economy.router)
    return app
