# Operations: what to read, what is gated, and what an upgrade can and cannot undo (v0.9.13)

The Preparation Framework's last foundation (the specification's section 15). It adds three things to the game, the gates of unfinished workflows, the counts an operator reads, and development fixtures, and writes down in one place what the other documents say in theirs: backups, migrations, compatibility and the limits of going back. Deploying itself is [deployment](deployment.md).

| Part | Where | Checked by |
| --- | --- | --- |
| [The site's numbers](#the-sites-numbers) | `api/operations.py`, `api/metrics.py` | `tests/test_operations.py`, `tests/test_games.py` |
| [The gates](#the-gates) | `api/rollout.py` | `tests/test_rollout.py` |
| [Jobs and retention](#jobs-and-retention) | `catalog/worker.py`, `api/accounts.py`, the engine | `tests/test_jobs.py`, `tests/test_maintenance.py` |
| [Migrations](#migrations) | `api/migrations/versions` | `tests/test_account_data.py`, `tests/test_migrations.py` |
| [Development fixtures](#development-fixtures) | `api/fixtures.py`, `python -m api.cli fixtures` | `tests/test_fixtures.py` |

## The site's numbers

`GET /api/v1/admin/operations`, for SysOp and administrators (`admin.audit.read`): signed in, open `https://<the site>/api/v1/admin/operations` in the browser. One answer gathers what was read in three places before and what was not counted at all.

Since v1.0.0 Administration has a **Numbers** tab over the same answer, for the same readers (`web/src/admin/SiteNumbers.tsx`): it begins with the games' record (`games`) and with how tables fit what they described (`table_fit`, with each answer's share), and has a button to read again. Under them are [the gates](#the-gates): every workflow's stage, who reaches it and when it was set; SysOp chooses another stage there and sets it. The rest of the answer (the API's counts, access by its state, the worker's jobs, the engine's own numbers) is still read as JSON; a panel over it is part of v1.0.0's close.

| Field | What |
| --- | --- |
| `version`, `migration` | The API's version and the migration it runs on |
| `since`, `now` | When this API process started counting, and the time of the answer. A restart starts the counts again |
| `counts` | The API's own counts since `since`, each a name, labels and a number (below) |
| `games` | `running` (games this process follows), `active` (games recorded as running), and how the last day's and week's games ended: `finished`, `interrupted` |
| `access` | Access given ([access](access.md)), by its state: `offered`, `accepted`, `given`, `declined`, `revoked`, `expired` |
| `rollout` | Every unfinished workflow's stage ([the gates](#the-gates)) |
| `jobs` | The worker's newest job of each kind, with its status and result code |
| `table_fit` | Since v1.0.0: how players said a table's game fit what its Rule Zero profile described, by the kind of game: `as_described`, `stronger`, `weaker` ([tables](tables.md#how-the-table-fit-v100)). Counts only, and shown nowhere else (the owner's decision 25) |
| `engine` | The engine's own numbers as it reports them: `processes` (budgets, each game's process, the bots' decision times, searches cut off, fallbacks, processes that ended unasked: [isolation](engine/isolation.md#what-the-operator-reads)) and `recordings` (checkpoints, recoveries and refusals: [recovery](engine/recovery.md#for-the-operator)). None while the engine does not answer |

### The counts

| Name | Labels | Counts |
| --- | --- | --- |
| `access.refused` | `code` | A request refused for who asked: every 401 and 403 by the code it answered with (`authentication_required`, `forbidden`, `csrf_failed`, `origin_refused`, …) |
| `access.refused` | `code`, `on=socket` | A game's socket closed for the same reasons |
| `access.refused` | `code=no_view_of_game` | A game's timeline asked for by an account that neither played it nor was given a view. Answered as a missing game |
| `access.refused` | `code`, `giving` | Access that could not be given: `not_available` (its workflow is not rolled out to both accounts), `blocked`, `account_unavailable`; `giving` is the kind (`deck`, `spectator`, `hand`, `replay`, `sandbox`) |
| `access.refused` | `code=not_rolled_out`, `workflow` | A route of a workflow that is off for the caller. Answered as a missing path |
| `settlement.recorded` | `status` | A game's end recorded: `finished` or `interrupted` |
| `settlement.retried` | | A write that must land waited for the database and tried again |
| `settlement.failed` | `outcome` | A game's end could not be recorded as it ended. `recorded_interrupted`: recorded with no result, nothing paid. `forced`: the game alone marked interrupted. `lost`: not even that; the next restart's sweep interrupts it |

A label is a code the API already answers with, a status or a workflow's name. No count names an account, a game, a deck or a card. `authentication_required` is the ordinary answer to a visitor who is not signed in, so it is the largest count on any day; what to look at is a change in the others.

**A game says why it paid nothing.** A game recorded interrupted because its end could not be written keeps `settlement_failed` as the reason for each reward it lost (`games.eligibility`, [modes](modes.md)); one that was only interrupted keeps `no_result`. The API's log has the error itself (`Could not record the end of game <id>`).

**What should be zero.** `settlement.failed` of any outcome; the engine's `checkpoints_skipped` and `recordings_stopped`; a job whose newest run is `failed` two days running. `settlement.retried` above zero means the database was away for a moment and the write landed afterwards.

### Diagnosing without seeing what is concealed

| To find out | Read | Shows of a game |
| --- | --- | --- |
| Whether the site is whole | `/api/v1/ready`, `/api/v1/engine/status`, `/api/v1/admin/operations` | Nothing |
| Why a game paid what it did | `games.eligibility` of that game | Its mode and reason codes |
| Whether a recording is whole | `RecordingTool` ([recovery](engine/recovery.md#for-the-operator)) | Seats, counts and sizes; nothing of a hand or library without `--show-private` |
| What happened in a game, as a seat saw it | `python -m api.cli timeline <game> --seat N`, or `--spectator` | What that seat, or everyone, could see |
| Everything in a game | `--inspection`, the timeline's `view=inspection`, SysOp's inspection drawer | Everything. Each reading through the API is audited (`games.events_inspected`, `game.inspection_opened`) |

The first three rows are the routine ones and show nothing concealed. The last is for a report that needs it, and leaves a record.

## The gates

v1.0.0's foundations are in the game ahead of the screens that use them. A foundation is finished and tested; the workflow a player would walk through it is not. Each unfinished workflow has a **stage**:

| Stage | Who reaches it |
| --- | --- |
| `off` | Nobody. Its routes answer as paths that do not exist, its access is neither given nor of any use, no game is made in its mode |
| `staff` | SysOp and administrators, to try it on the live site |
| `on` | Everyone |

Every workflow is `off` until it is set.

| Workflow | Delivers (spec §) | Guards today | Paths reserved for its routes (after `/api/v1`) |
| --- | --- | --- | --- |
| `save_resume` | Save and resume (17) | Since v1.0.0 saving, resuming and discarding a game against the bots, and a private table's suspension by its players' vote ([games](games.md#save-and-resume-v100)); recovery itself is on for everyone | `/saves`, `/games/{id}/save`, `/tables/{id}/suspension` |
| `sandbox` | The practice sandbox (19) | Sandbox access; the `sandbox` mode | `/sandbox` |
| `deck_lending` | Friend deck lending (20) | A lent deck's access; the `borrowed` mode | `/loans`, `/decks/{id}/loans` |
| `replays` | Replays and review (23) | Since v1.0.0 a game played back, a reader's bookmarks and notes, and a replay shared with a friend ([replays](replays.md)); a shared replay's access | `/replays`, `/games/{id}/replay` |
| `spectators` | Spectators (24) | A spectator's access | `/games/{id}/spectators`, `/tables/{id}/spectators` |
| `coaching` | Coaching (24) | A coach's access to a seat's hand | `/games/{id}/coaches` |
| `starter_tables` | A starter deck bought at the table (the owner's own request, 2026-11-14) | A table or a practice game asked to be one (`starter`) | `/starter-decks` |

**Setting a stage.** SysOp, since v1.0.0 in Administration's Numbers tab: under "The gates" each workflow has its stage as a choice and a "Set" button beside it, two steps, since a stage decides who meets a workflow on the live site; an administrator sees the stages there and sets none. It sends `PUT /api/v1/admin/rollout/{workflow}` with `{"stage": "staff"}` (the permission `rollout.manage`, SysOp's alone). At the console, on the VM: `docker compose exec api python -m api.cli rollout sandbox staff`; `rollout` alone prints every stage. Either way the change is in the audit record (`rollout.stage_changed`, the console's with `"by": "console"`). `GET /api/v1/admin/rollout` shows the stages to staff, and `GET /api/v1/rollout` tells any signed-in account which workflows it may reach, which is what a page asks before it shows the way into one.

**What a gate guards.**

- **Routes.** A workflow's routes are made on `rollout.router(workflow)`, which checks the gate before the route runs. The API does not start with a route under a reserved path that is not behind its workflow's gate (`rollout.unguarded`), so a route added later cannot be left open by forgetting.
- **Access.** Each kind of access belongs to a workflow. While the workflow is not available to an account, access of that kind can neither be offered by it nor to it, and a grant it holds gives it nothing. Switching a workflow off stops its access at once; switching it on again gives it back.
- **Modes.** `rollout.mode_available` says whether a game may be made in the sandbox's mode or a borrowed deck's. v1.0.0's routes that make such games ask it.

**What has no gate, because it is finished:** recovery after a restart, a game's timeline for its own players (`GET /api/v1/games/{id}/timeline`), the deck workshop's services, Rule Zero table profiles, batch declarations and yields. Playgroups, scheduling and leagues were dropped by the owner on 2026-11-14 and have nothing to gate; the two words v0.9.10 kept for their access (`group`, `pool`) are refused always.

## Jobs and retention

| Job | Runs | Removes or does | Safe to run again |
| --- | --- | --- | --- |
| Account cleanup (`account_cleanup`) | Daily, the worker | Accounts never approved after 30 days; friends' messages after 365 days and table chat after 30; games' structured events 90 days after the game ended | Yes: each removes what is past its cutoff, and a second run finds nothing due |
| Catalog sync (`catalog_sync`) | Daily at 10:00 UTC, the worker | Imports Scryfall's bulk data as a new revision; nothing is deleted | Yes: an unchanged day imports nothing |
| Booster data (`booster_sync`) | Weekly, the worker | MTGJSON's set files for the shop's collations | Yes |
| Auction settlement | Every 10 s, the worker | Settles auctions that ended, each in its own transaction under its row's lock | Yes: a settled auction is not settled again |
| Recordings sweep | Every 5 minutes, the engine | A game's recording once nothing in it changed for 24 hours (`CD_ENGINE_RECORDING_RETENTION_HOURS`); a running game's never | Yes |
| Notifications | As an account's bell is read | Notifications older than 90 days and past the newest few hundred | Yes |
| Nightly dump | 04:30, the VM's timer | `pg_dump` into `backups/`; keeps 14 nightly, 10 pre-deploy, 5 pre-restore, and the dumps a rollback needs | Yes: a dump is checked before any older one is pruned |

A worker's job is claimed under a row lock, with a lease and a generation number: a worker that was slow or died is taken over after its lease, and its late result is refused (`tests/test_jobs.py`). A failed run stays `failed` with its code and the next day's run tries again. `tests/test_maintenance.py` runs the daily cleanup twice over the same data.

**What is kept how long, and where.** The database (accounts, libraries, decks, ledgers, results, the audit record): for good, in the nightly dumps. A game's events: 90 days after it ended. A game's recording: 24 hours after it last changed, in the engine's volume, never in a backup ([deployment](deployment.md#recordings-v099)). Card images and Scryfall's bulk files: fetched again when missing.

## Migrations

**The rule: expand only.** `deploy.sh` runs a version's migrations while the previous version is still serving, so a migration only adds what the previous version can ignore: tables, nullable columns, columns with a default, indexes. A drop or a rename waits for a later version that no longer uses what is dropped ([deployment](deployment.md#deploying-a-version)).

**The one exception: migration 0050** (v0.9.13), the owner's decision to take out what the economy's foundations left ([the economy](economy.md#the-data)). It drops a table and a column that v0.9.12's API still reads. So between the migration and the restart, a few seconds, the v0.9.12 API still running cannot read quest boards or libraries and answers those requests with an error. Deploy v0.9.13 when nobody is playing, as for any upgrade: an upgrade ends the running games anyway. The migration refuses, changing nothing, a database where an economy policy was ever used.

**Every migration is run against an account.** `tests/test_account_data.py` writes a representative account at v0.9.9's schema (tokens, wins, a library by edition and finish, decks with revisions, quests, achievements, the campaign, auctions, packs, sleeves, a role), adds at each later migration the rows that migration is about, runs every migration to the newest and back to v0.9.9's and forward again, and compares the account's totals at each step, on SQLite and PostgreSQL. A new table that refers to accounts fails the suite until it is in the account or named as holding nothing an account keeps.

## Compatibility

| Between | Rule |
| --- | --- |
| The API, the engine and the web of a version | Deployed together, from one tag. The engine's service routes are the API's alone and change with it |
| The API and the database | A version runs only on a database at its own last migration: its API reports ready at no other |
| The browser and the API | `/api/v1` changes by adding. `contracts/openapi.json` is generated, and CI fails when it drifts. A page loaded before an upgrade keeps working against the routes it knows; a message type it does not know is ignored |
| A recording and the engine | A recording is played on only by the engine build that made it. Every release is a new build, so an upgrade ends the games running then; a restart of the same version does not |
| Events and their readers | Each event carries its schema version (`v`: 1). Events outlive engine builds, so a reader keeps reading every version once written |
| The private images | The private engine (custom cards) and web (music, rules text) images are built from the public images of the same version and deployed with it |
| A deploy kit and its version | Each tag deploys with its own kit (`kits/<tag>/`), and comes back with its own |

## Rollback limits

Going back to the version before is always possible; what it costs depends on whether the version being left added a migration.

| Leaving | Its migrations | Going back |
| --- | --- | --- |
| v0.9.13 | 0050, which drops what v0.9.12 reads | Restore the dump taken before it was deployed, then deploy 0.9.12. Everything written since the deploy is lost |
| v0.9.12 | 0047 to 0049 (new tables and nullable columns) | The same: restore, then deploy 0.9.11 |
| v0.9.11 | None | Deploy 0.9.10. Nothing is lost |
| v0.9.10 | 0044 to 0046 | Restore, then deploy 0.9.9 |
| v0.9.9 | None; it adds the recordings volume | Deploy 0.9.8, which ignores the volume |

The commands, and which dump: [deployment, rolling back](deployment.md#deploying-a-version). `deployed.env` names the dump (`CD_ROLLBACK_DUMP`), and the backups never prune it.

**What no rollback gives back.** Games running at an upgrade end interrupted, in either direction. A restore loses everything written after its dump: games, purchases, auctions, messages. The token ledger, results and the audit record are append-only in PostgreSQL, so nothing short of a restore rewrites them. After migration 0050 the farming signals v0.9.12 recorded and the economy policies' settings are gone from the live database; only a dump from before it holds them.

**When a deploy fails.** A failed pull, dump or migration replaces nothing: the previous version keeps serving. A version that migrated and then does not start is not replaced by the previous one, which cannot run on the moved database; `deploy.sh` prints the restore and deploy commands, and the site is down until one of them, or a fixed tag, is run.

## Development fixtures

`python -m api.cli fixtures` writes into a development database what v1.0.0's workflows read and no route can make yet, the same every time (every id is derived from its name):

- four accounts: `fixture-ada` and `fixture-bea` (the game's players), `fixture-cal` (a player with no seat in it), `fixture-eve` (an administrator);
- one finished table game between ada and bea with a short record of structured events of every visibility: a card only its seat sees, spells everyone sees, damage, a creature dying, the game's end;
- the access v1.0.0 will give: cal watches the game as a spectator, cal replays it through bea's seat, eve is shown ada's hand as a coach.

`--sessions` signs each account in for a day and prints its cookie, for `curl` or the browser's developer tools. `--rollout staff` or `--rollout on` stages every workflow in that database; without it the access gives nothing, which is the gate at work. It refuses a database whose settings say production (`CD_ENVIRONMENT`), and the live site's do.

The engine's own reproducible scenarios are its fixtures: the fixture decks, the three large boards with recorded baselines ([large boards](engine/large-boards.md)), and the recovery tests' seeded games ([recovery](engine/recovery.md)).

## Capacity

The live VM has 32 vCPUs and 96 GB. The engine's budget, each game size's heap and how many games it admits are settings ([isolation](engine/isolation.md#settings)); a full engine refuses a new game in words. `CD_GAMES_MAX` bounds the games the API runs at once and `CD_GAMES_PER_ACCOUNT` an account's. The operating envelope under load is v1.0.0's capacity test to set.
