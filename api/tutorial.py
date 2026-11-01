"""The first-time tutorial (v0.8.4, docs/menus.md#the-tutorial): how a new player chose to learn the
game, and how far they are, kept on the account so it picks up after a reload and on any device.

- **Paths.** Beginner watches a scripted game between two bots, explained move by move, then sets
  up their game with tips and gets the main menu's tour; Novice reads an overview of the site with
  a refresher on Magic's rules, then the same; Advanced goes straight to the setup.
- **Stages.** choose, then demo (Beginner) or overview (Novice), setup, the tour's tour_shop (to
  Leng's card shop and a first pack) and tour_auctions (to Tivit's Auction House and a first
  listing), done. The browser moves the stage along: the tutorial is guidance only, and nothing
  in it is paid for or granted. Skipping goes to done and says so.
- **Again later.** Settings › Tutorial plays the scripted game or the overview again without
  changing anything here, and starts the tour again from tour_shop.
"""

from fastapi import APIRouter

from api.auth import INPUT_ERRORS
from api.identity import ApiError, Db, SignedIn, me_of, utcnow
from api.schemas import Me, TutorialUpdate

router = APIRouter(prefix="/api/v1")

# The stages each path passes through; done is open to every path, as a skip, and so is the tour,
# which Settings starts again for anyone.
STAGES = {
    "beginner": {"demo", "setup", "tour_shop", "tour_auctions", "done"},
    "novice": {"overview", "setup", "tour_shop", "tour_auctions", "done"},
    "advanced": {"setup", "tour_shop", "tour_auctions", "done"},
}


@router.put("/me/tutorial", response_model=Me, responses=INPUT_ERRORS)
def update_tutorial(body: TutorialUpdate, principal: SignedIn, db: Db) -> Me:
    """Moves the account's tutorial to a stage, choosing its path with the first one."""
    user = principal.user
    if user.status != "active":
        raise ApiError(403, "account_inactive", "Your account is not active.")
    path = body.path or user.tutorial_path
    if body.stage == "choose":
        path = None
    elif path is None:
        raise ApiError(422, "tutorial_path", "Choose how you want to learn the game first.")
    elif body.stage not in STAGES[path]:
        raise ApiError(
            422, "tutorial_stage", f"The {path} tutorial has no {body.stage.replace('_', ' ')}."
        )
    user.tutorial, user.tutorial_path = body.stage, path
    user.tutorial_skipped = body.stage == "done" and body.skipped
    user.updated_at = utcnow()
    db.commit()
    return me_of(db, principal)
