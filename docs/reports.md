# Problem reports (v0.4.1)

v0.4.1 adds "Report a problem" for the beta testers, and a Reports tab in Administration where SysOp and administrators read what they send. The owner chose an in-app form, with an optional screenshot, over GitHub issues or email at the start of v0.4.1 ([the plan](plans/0.4.1.md#decisions-at-the-start-of-v041)). The code is `api/reports.py`, `web/src/app/ReportProblem.tsx`, `web/src/app/screenshot.ts` and `web/src/admin/Reports.tsx`.

## What a tester sees

- **Where.** "Report a problem" is in the top bar of every page of the app, beside the version. At a table it is in the Game menu, between Table options and Concede, and the report carries that game and its turn. Accounts that are not active never see the app, so they cannot report; the public pages give them `info@thesphinx.co` ([the public pages](identity.md#the-public-pages-v041)).
- **The form** is a dialog:
  - **Summary**: up to 120 characters.
  - **What happened? What did you expect?**: up to 4,000 characters.
  - **Screenshot (optional)**: chosen as a file (on a phone this opens the photo library), pasted with Ctrl+V or ⌘V anywhere in the dialog, or dropped on it. A preview shows it with its size, and Remove the screenshot takes it off.
  - A line saying what else is sent (below), and that only the site's administrators read reports.
- **After sending** the dialog says "Thank you. Your report was sent." and that there is no reply in the app. Closing it after a report was sent leaves an empty form for the next one; a report that was not sent keeps its draft.
- **Accessibility.** The dialog is modal (`<dialog>`: focus stays inside and Escape closes it), and its fields have labels. What happens to the screenshot and to the sending is said in a status line; refusals are alerts. After sending, focus moves to the thank-you heading.

## Reporting a chat message (v0.4.4)

Each message from another player, between friends or in a table's chat, has **Report** in its menu. A short dialog shows the message and asks why (optional); it sends a report whose summary names the sender, with `message: {"kind": "direct" or "table", "id": "..."}`. The API copies the message and the 20 messages before it that the reporter saw into the report (`chat`), with who sent it (`reported_user`). Administration's list marks such a report "Message from …", and its detail shows the copy with the reported message marked. Administrators read chat messages only so ([chat](chat.md#reports-of-a-message)). The 20 reports a day count these too.

## What is attached

The dialog says so in plain words: "We'll also send: this page, the version, the game and turn, your browser and screen size, and the IDs of your last requests to the site." The game and turn appear only at a table. In detail:

| Sent | Taken from |
| --- | --- |
| The page: its address after `#`, without anything after a `?` (at most 200 characters) | The page |
| The web app's version | The page. An installed app that has not updated yet may be older than the API |
| The API's version | The API, when the report arrives |
| The window's size and pixel ratio | The page |
| The game's ID and its turn, from a table | The page |
| The browser | The request's `User-Agent` header, read by the API (at most 512 characters) |
| The latest API requests, at most 20: method, path without its query, status (0 when no answer came), request ID and time | The page's memory (below) |

**The latest requests.** `web/src/api.ts` notes each request the app's API client makes: its method, its path, the answer's status and `X-Request-ID`, and the time. It never keeps a query string, a body or another header, and it leaves out the counts the page asks for every minute ([counts](#counts)). Only the latest 20 are kept, in the page's memory; a reload starts again. Each request ID matches a line of the API's log, so an administrator can find what the server did.

Nothing else is sent: no cookie, email address, location, other tab or file. The context is information only: nothing in it is checked against the account or decides anything.

## The screenshot

- **Types and size.** PNG, JPEG or WebP, at most 5 MB (5 × 1024 × 1024 bytes, as a computer shows file sizes).
- **In the browser** (`web/src/app/screenshot.ts`). A file within 5 MB and 2,560 pixels on its long edge goes as it is. A larger one is drawn at most 2,560 pixels on a canvas and encoded as WebP (JPEG where the browser cannot write WebP) at falling quality until it fits, and drawn smaller again if no quality does. The preview is a `data:` address, because the site's Content-Security-Policy allows images only from the site and from `data:`.
- **On the server** (`api/reports.py`), with Pillow 12.3.0:
  1. The base64 must decode to at most 5 MB, and Pillow must read it as PNG, JPEG or WebP; anything else is refused (`422 invalid_image`), a damaged or crafted file included, never with a 500.
  2. Its size, read from its header before any pixel is unpacked, must be at most 40 million pixels (`422 image_too_large`). This bounds what a request made by hand can make the API unpack; Pillow's own limit (178 million) stays behind it. At most two screenshots are decoded at once.
  3. It is shrunk to at most 2,560 pixels on its long edge (the first frame of an animation only), turned upright by its EXIF orientation, and encoded again as WebP (quality 85) from its pixels alone.
  4. The new file holds no EXIF, GPS, XMP, ICC profile or text of the original. `tests/test_reports.py` sends a JPEG with all of these and checks that none is left.
- **The proxies.** nginx takes requests of at most 1 MB unless told otherwise. Both proxies take up to 8 MB on `/api/v1/reports` alone, about what a 5 MB screenshot is in base64: the web container (`web/nginx.conf`, deployed with the image) and the TSH proxy (`deploy/nginx/duels.thesphinx.co`, which the owner applies by hand, [deployment](deployment.md#on-the-tsh-proxy)). If a proxy still refuses a report whose screenshot is over 750 KB (413, or a dropped connection), the page makes the screenshot smaller, to 750 KB, and sends the report once more.

## Limits

- **20 reports in any 24 hours** per account. The 21st is refused with `429 too_many_reports` and a `Retry-After` header saying when the next may go. SysOp has no limit.
- **Text.** The summary and the description are trimmed and must not be empty. NUL characters are refused in every text field (`422 invalid_request`), as elsewhere in the API. The app's version is at most 32 characters, and a request's path 200.
- **Who.** Any active account. Signed out: 401. Pending or denied: 403. The request needs the session's CSRF token, like every change.

## Statuses

| Status | Means |
| --- | --- |
| `new` | Unread. Counted in Administration. |
| `seen` | Opened by SysOp or an administrator. Opening a new report in the Reports tab marks it seen. |
| `fixed` | Fixed, or the fix is planned for a named version. |
| `closed` | Done without a fix: not a bug, a duplicate, or not reproducible. |

Any status may be set from any other, `new` included, to mark a report unread again. Each change is audited as `admin.report_status_changed`, with the report's ID and the statuses `from` and `to`; the audit entry's account is the reporter. Setting the status a report already has records nothing. Opening a new report goes through the same route, so a report's first reading is in the audit trail too.

## Who reads them

The permission `reports.manage`, held by administrators and SysOp ([roles and permissions](identity.md#roles-and-permissions-auth06-auth07-sec05)). Moderators and content editors do not hold it.

**The Reports tab** lists reports newest first, new and seen ones by default; its filter also offers New, Seen, Fixed, Closed and All reports. Each shows its summary, the reporter's handle and display name, the time, the page, the web app's version, the game and turn, whether it has a screenshot, and its status. Opened, a report shows its description, the reporter's ID, both versions, the browser, the window, the latest requests with their IDs, the screenshot and the status to set. The screenshot is a plain image from `/api/v1/admin/reports/<id>/screenshot`, sent with the session's cookie; it opens full size in a new tab. To administrators, a report SysOp sent is the Site administrator's, as in the audit trail.

## Counts

SysOp and administrators see how many accounts wait for approval and how many reports are unread:
- a badge on Admin in the navigation, whose name for screen readers says both, for example "Admin, 2 accounts waiting for approval, 1 unread report";
- the counts on Administration's Accounts and Reports tabs, and on Accounts a button that shows the waiting accounts;
- the browser tab's title, prefixed with the total, for example "(3) Commander Duels", on every page and at a table.

The page asks `GET /api/v1/admin/counts` once a minute while it is shown, at once when the window regains focus or is shown again, and after an approval or a status change in Administration. A hidden page waits. Each count is null for an account without the permission behind it: `admin.users.manage` for waiting accounts (the permission that approves them), `reports.manage` for unread reports; the page does not ask at all for an account that holds neither. These questions are not activity: they do not extend the session's idle limit (`identity.BACKGROUND_PATHS`), so a tab left open still signs out after 14 days without use, or SysOp's after 60 minutes.

## The API

| Route | Who | What |
| --- | --- | --- |
| `POST /api/v1/reports` | Any active account | Sends a report; 201 with its ID |
| `GET /api/v1/admin/reports` | `reports.manage` | Newest first, 50 a page (`limit` up to 100), `cursor` for the next; `status` repeated to filter (`?status=new&status=seen`) |
| `GET /api/v1/admin/reports/{id}` | `reports.manage` | One report in full |
| `GET /api/v1/admin/reports/{id}/screenshot` | `reports.manage` | `image/webp`, `Cache-Control: private, no-store`, `nosniff`; 404 when there is none, and to anyone without the permission |
| `POST /api/v1/admin/reports/{id}/status` | `reports.manage` | Sets the status; audited |
| `GET /api/v1/admin/counts` | Any active account | `{pending_accounts, unread_reports}`, each null without its permission |

## Storage and backups

- **The table** `problem_reports` (migration `0012_reports`) holds each report, its context and its screenshot: WebP bytes in a `bytea` column, with the width and height. Its indexes are status and time (the list) and account and time (the daily limit and deletion). The game's ID is context only, with no foreign key.
- **Backups.** The screenshot is in the database, not on disk, so the nightly `pg_dump` and the dumps before each deploy and restore hold every report with its screenshot, and a restore brings them back ([backups](deployment.md#backups)). A re-encoded screenshot is typically a few hundred KB.
- **Keeping.** Reports stay until an administrator deletes the account that sent them: account deletion removes its reports, screenshots included, with `api.reports.delete_reports_of` ([deleting an account](identity.md#deleting-an-account-v041)). The nightly dumps keep them 14 more days, and the dumps before deploys and restores until newer ones replace them.
