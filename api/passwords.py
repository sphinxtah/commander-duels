"""SysOp's password: Argon2id with argon2-cffi's current recommended parameters."""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

MIN_LENGTH = 12
_hasher = PasswordHasher()
# Checked when no SysOp exists, so a missing account costs the same time as a wrong password.
_DUMMY_HASH = _hasher.hash("commander-duels-no-sysop")


def hash_password(password: str) -> str:
    if len(password) < MIN_LENGTH:
        raise ValueError(f"The password must be at least {MIN_LENGTH} characters.")
    return _hasher.hash(password)


def verify_password(stored: str | None, password: str) -> bool:
    try:
        return _hasher.verify(stored or _DUMMY_HASH, password) and stored is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(stored: str) -> bool:
    return _hasher.check_needs_rehash(stored)
