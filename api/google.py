"""Google ID-token verification with Google's own library (AUTH01).

google-auth checks the signature against Google's published certificates, the audience (our
client ID), the issuer and the expiry. The caller checks the sign-in nonce. Certificates are
fetched through httpx and cached for as long as Google's Cache-Control allows.
"""

import re
import time
from collections.abc import Mapping
from typing import Any

import httpx
from google.auth import exceptions, transport
from google.oauth2 import id_token

ISSUER = "https://accounts.google.com"
_MAX_AGE = re.compile(r"max-age=(\d+)")


class InvalidToken(Exception):
    """The credential is not a valid Google ID token for this application."""


class ProviderUnavailable(Exception):
    """Google's certificates could not be fetched."""


class _Response(transport.Response):
    def __init__(self, status: int, headers: Mapping[str, str], data: bytes) -> None:
        self._status, self._headers, self._data = status, headers, data

    @property
    def status(self) -> int:
        return self._status

    @property
    def headers(self) -> Mapping[str, str]:
        return self._headers

    @property
    def data(self) -> bytes:
        return self._data


class CachingTransport(transport.Request):
    """google-auth's transport interface over httpx, caching successful GETs by max-age."""

    def __init__(self, client: httpx.Client) -> None:
        self._client = client
        self._cache: dict[str, tuple[float, _Response]] = {}

    def __call__(
        self,
        url: str,
        method: str = "GET",
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
        **kwargs: Any,
    ) -> _Response:
        cached = self._cache.get(url) if method == "GET" else None
        if cached and cached[0] > time.monotonic():
            return cached[1]
        try:
            reply = self._client.request(
                method, url, content=body, headers=headers, timeout=timeout or 5
            )
        except httpx.HTTPError as error:
            raise exceptions.TransportError(str(error)) from error  # type: ignore[no-untyped-call]
        response = _Response(reply.status_code, dict(reply.headers), reply.content)
        age = _MAX_AGE.search(reply.headers.get("cache-control", ""))
        if method == "GET" and reply.status_code == 200 and age:
            self._cache[url] = (time.monotonic() + int(age.group(1)), response)
        return response


class GoogleVerifier:
    def __init__(self, client_id: str, request: transport.Request) -> None:
        self.client_id = client_id
        self._request = request

    def verify(self, credential: str) -> dict[str, Any]:
        try:
            claims = id_token.verify_oauth2_token(  # type: ignore[no-untyped-call]
                credential, self._request, audience=self.client_id, clock_skew_in_seconds=10
            )
        except exceptions.TransportError as error:
            raise ProviderUnavailable(str(error)) from error
        except (ValueError, exceptions.GoogleAuthError) as error:
            raise InvalidToken(str(error)) from error
        if not isinstance(claims, Mapping) or not claims.get("sub"):
            raise InvalidToken("The token has no subject.")
        return dict(claims)
