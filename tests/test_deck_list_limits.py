"""Deck list text from players (deck import) and from SysOp (typed deck lists): a long line is
refused before any pattern reads it, and runs of spaces read as one (v0.8.3): the patterns take
time growing with the square of a long run of spaces."""

import time

import pytest

from api.deckio import MAX_LINE_CHARS, parse_text
from api.decklists import MAX_LINE, parse_deck_list
from api.identity import ApiError

# Within the 64 KB a deck list may have: one line, nearly all spaces.
HOSTILE = "a" + " " * 60_000 + "b"


def test_a_padded_line_reads_at_once_and_a_long_line_is_refused() -> None:
    started = time.perf_counter()
    parsed = parse_text(HOSTILE, "commander")
    assert [(line.quantity, line.name) for line in parsed.lines] == [(1, "a b")]
    assert time.perf_counter() - started < 1
    with pytest.raises(ApiError) as refused:
        parse_text("1 " + "x" * MAX_LINE_CHARS, "commander")
    assert refused.value.code == "invalid_deck_list"
    assert f"at most {MAX_LINE_CHARS} characters" in refused.value.message


def test_a_long_run_of_spaces_inside_a_short_line_reads_as_one_space() -> None:
    text = "4x   Lightning \t  Bolt   (M10)   146\n" + "1" + " " * 250 + "Island"
    parsed = parse_text(text, "legacy")
    assert [(line.quantity, line.name, line.set_code, line.number) for line in parsed.lines] == [
        (4, "Lightning Bolt", "m10", "146"),
        (1, "Island", None, None),
    ]


def test_sysop_deck_lists_read_a_padded_line_at_once_and_refuse_a_long_one() -> None:
    started = time.perf_counter()
    with pytest.raises(ApiError):
        # Read at once as the card "a b", which is no deck on its own.
        parse_deck_list(HOSTILE, "commander")
    assert time.perf_counter() - started < 1
    with pytest.raises(ApiError) as refused:
        parse_deck_list("1 " + "x" * MAX_LINE, "legacy")
    assert refused.value.code == "invalid_deck_list"
    assert f"at most {MAX_LINE} characters" in refused.value.message
    listed = parse_deck_list("20   Mountain", "legacy")
    assert listed["cards"] == [{"name": "Mountain", "count": 20}]
