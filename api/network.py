"""Client addresses. X-Forwarded-For is believed only from configured proxies, so a forwarded
header cannot fake the network a request comes from."""

from ipaddress import IPv4Address, IPv6Address, ip_address

from starlette.requests import Request

from api.config import Network

Address = IPv4Address | IPv6Address


def parse_address(value: str) -> Address | None:
    try:
        address = ip_address(value.strip().split("%")[0])
    except ValueError:
        return None
    if isinstance(address, IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def within(address: Address | None, networks: list[Network]) -> bool:
    return address is not None and any(address in network for network in networks)


def client_address(request: Request, trusted_proxies: list[Network]) -> Address | None:
    """The address of whoever sent the request: the peer, or, when the peer is a trusted proxy,
    the nearest X-Forwarded-For hop that is not one. Malformed chains count as unknown."""
    peer = parse_address(request.client.host) if request.client else None
    if not within(peer, trusted_proxies):
        return peer
    hops = [
        hop for header in request.headers.getlist("x-forwarded-for") for hop in header.split(",")
    ]
    for hop in reversed(hops):
        address = parse_address(hop)
        if address is None:
            return None
        if not within(address, trusted_proxies):
            return address
    # Every hop is a trusted proxy: the request started inside the proxy chain.
    return parse_address(hops[0]) if hops else peer
