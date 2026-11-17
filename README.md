# Creator Timesheet Widget

A time‑tracking widget for **Zoho Creator** portals, hosted on **Zoho Catalyst**. Employees Check In,
take typed breaks, Resume, and Check Out, with a live **Work** timer and a parallel **Break** timer.
State lives server‑side in Creator, so refreshing, closing the tab, or switching devices never loses
the shift.

This repo is a **reference implementation** of a pattern that is surprisingly fiddly to get right:
embedding an externally‑hosted widget in a Creator portal and calling back into Creator **as the
logged‑in portal user**, with server‑verified identity and no tokens in the browser.

---

## Architecture

Two platforms, one clean split:

- **Zoho Catalyst — static frontend hosting only.** Serves the widget's HTML/JS/CSS (Web Client
  Hosting). No Catalyst Functions or Cache.
- **Zoho Creator — backend, data, and identity.** All server logic runs as **Deluge inside Custom
  APIs**, executed as the logged‑in **portal user** (`zoho.loginuserid`). Data lives in a `Timesheets`
  form + a `Breaks` subform.
- **The widget calls Creator** via the Widget JS SDK (`ZOHO.CREATOR.DATA.invokeCustomApi`) in the
  user's session, so identity is server‑verified with **no tokens in the browser**.

```
Browser (portal user)
  └─ Creator portal page  (<portal-domain>)
       └─ <iframe> widget  ── hosted on ──▶  Catalyst Web Client  (<project-domain>.catalystserverless.com/app/)
              └─ ZOHO.CREATOR.DATA.invokeCustomApi(...)  ── runs as the portal user ──▶
                   Creator Custom APIs (Deluge)  ──▶  Timesheets / Breaks
```

**Why this shape** (the non‑obvious bits):
- Creator **portal users cannot use the generic Data APIs** — but they *can* invoke an **OAuth2
  Custom API scoped to "Portal users"** from inside a widget, and that Deluge runs as them. That's the
  whole identity story: no OAuth dance, no stored tokens.
- Catalyst Web Client Hosting sends `X-Frame-Options: DENY` by default, so each embedding domain must
  be allow‑listed in Catalyst **Authorized Domains** (iFrame) before the widget will render in the portal.

---

## Repository layout

| Path | What |
|------|------|
| `client/index.html`, `main.js`, `main.css` | The widget (UI + state machine + parallel timer engine) |
| `catalyst.json` | Catalyst project config (client‑only) |
| `creator/custom-apis.md` | **Source of truth for all Deluge** — the Custom APIs + logging + expiry job |
| `CONFIGURATION.md` | Architecture + configuration reference, and the *why* behind each decision |
| `SECURITY_REVIEW.md` | Security review (model, findings, accepted risks) |

> This widget is adapted to a specific Creator schema (a `Timesheets` form with a `Breaks` subform,
> an `Employees` form with scheduled start/end times, and an IP allow‑list). Treat the Deluge in
> `creator/custom-apis.md` as a worked example and adapt the field/form names to your app.

---

## The Custom APIs (Creator)

All are **OAuth2, User Scope = "Portal users"**, return JSON (epoch‑ms timestamps), derive identity
from `zoho.loginuserid`, and never write secrets to the client. Full source in `creator/custom-apis.md`.

| Custom API | Method | Purpose |
|------------|--------|---------|
| `WidgetGetState` | GET | Current shift state + timer source data (the read path) |
| `WidgetCheckIn` | POST | IP allow‑list → on‑site insert, or a "remote" branch that returns a form URL |
| `WidgetGoOnBreak` | POST (`breakType`, `note`) | Adds a `Breaks` row (break type whitelisted) |
| `WidgetResume` | POST | Closes the open break |
| `WidgetCheckOut` | POST | Sets time out, working time, overtime; closes open breaks |
| `WidgetExpireStaleShifts` | **Scheduled** | Flags shifts left open past their scheduled end + grace as `No Check-Out` |

There's also a small **app‑wide logging** helper (`App_Logs` form + `tools.logInfo/logWarn/logError`)
because Creator does not expose runtime execution logs for Custom APIs — see `creator/custom-apis.md` §7.

---

## The widget

- **States:** `idle` → `working` ⇄ `on_break` → `checked_out`, with buttons shown per state.
- **Parallel timers:** Work = continuous (counts through breaks); Break = parallel. Reconstructed from
  the server's epoch timestamps at load, then ticked locally (clock‑skew‑immune).
- **Persistence:** server‑side via the Custom APIs (the widget re‑fetches state after each action);
  `localStorage` gives an instant paint on load with an offline fallback.
- **Responsive:** fills the iframe and adapts to **portrait**, **landscape**, and a short **strip**
  layout (driven by the iframe's size), including mobile.
- **Theme:** a small, swappable palette defined as CSS variables in `client/main.css` (`--ink`,
  `--bone`, `--terra`, `--jungle`, `--sand`). Change those to re‑theme.

---

## Setup & deploy

Prerequisites: a Zoho Catalyst project, a Zoho Creator app/portal, and the Catalyst CLI
(`npm i -g zcatalyst-cli`).

1. **Clone & link** to your Catalyst project:
   ```bash
   catalyst login
   catalyst project:use <PROJECT_ID> --org <ORG_ID>
   ```
   (This writes a local `.catalystrc` — it is git‑ignored on purpose; it contains your IDs.)

2. **Deploy the widget** (static client):
   ```bash
   catalyst deploy --only client
   ```
   The client is served at `https://<project-domain>.catalystserverless.com/app/index.html`.

3. **Allow the portal domain to frame it.** In the Catalyst console →
   *Cloud Scale → Authentication → Whitelisting → Authorized Domains*, add each domain that embeds the
   widget (your Creator builder domain and your portal domain) with **iFrame** enabled. (This requires
   at least one Catalyst auth method configured first.)

4. **Create the Custom APIs** from `creator/custom-apis.md` (OAuth2, scope **Portal users**), plus the
   `App_Logs` form and the `tools` helpers. Grant the portal permission set **Add** on `App_Logs`.

5. **Register the widget in Creator** with Hosting = **External**, index URL = the Catalyst client URL,
   and drop it on a (non‑published) portal page.

To ship a UI change later, edit `client/*` and re‑run `catalyst deploy --only client`.

### Local preview
`.claude/launch.json` defines a `widget-preview` static server (`npx serve client`). The Creator SDK
calls won't resolve outside the portal (the widget falls back to an idle/offline state), but it's
enough to check the layout and responsiveness.

---

## Security

Identity is always server‑derived (`zoho.loginuserid`), never client‑supplied; every read/write is
scoped to the caller's own records; the on‑site/remote decision uses a server‑side IP; and there are
no secrets in the client. Details and accepted risks in `SECURITY_REVIEW.md`.

---

## License

MIT — see `LICENSE`.
