"""The API image holds every content file the API reads (v0.8.0's campaign shipped without
content/campaign.json, and since v0.5.1 the print runs had been left out the same way)."""

import re
from pathlib import Path

from api.campaign import CAMPAIGN_FILE
from api.how_to_play import CARDS_FILE

# Every file the API reads from its content folder (settings.content_dir, /app/content in the
# image): add a file here when the API starts reading it.
READ_BY_THE_API = {
    "planeswalkers.json",
    "starter-decks.json",
    "starter-deck-prices.json",
    "pack-prices.json",
    "pack-art.json",
    "print-runs.json",
    CAMPAIGN_FILE,
    # How to play's example cards (v0.8.6).
    CARDS_FILE,
}


def test_the_api_image_copies_every_content_file_the_api_reads() -> None:
    dockerfile = Path("api/Dockerfile").read_text(encoding="utf-8")
    copied = set(re.findall(r"content/([\w.-]+\.json)", dockerfile))
    assert READ_BY_THE_API <= copied, sorted(READ_BY_THE_API - copied)
    for name in READ_BY_THE_API:
        assert (Path("content") / name).is_file(), name


def test_the_list_names_every_content_file_the_api_opens() -> None:
    """Each content file named in the API's code is on the list above."""
    named: set[str] = set()
    for source in Path("api").glob("*.py"):
        text = source.read_text(encoding="utf-8")
        named |= set(re.findall(r'Path\(folder\) / "([\w.-]+\.json)"', text))
    named.add(CAMPAIGN_FILE)
    named.add(CARDS_FILE)
    assert named <= READ_BY_THE_API, sorted(named - READ_BY_THE_API)
