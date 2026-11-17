# Security Review — Time Tracker Widget

Reviewed: 2026-06-09. Scope: the widget (Catalyst-hosted static client), the Creator Custom APIs (Deluge), Catalyst config, and the trust boundaries between them.

## Verdict
**No high-severity issues.** The identity/authorization model is sound: every server operation derives the user from server-side `zoho.loginuserid` inside Portal-scoped Custom APIs, and all data access is filtered to the caller's own records. A few low-severity hardening + cleanup items below.

---

## Strengths (verified)
- **Server-verified identity, never client-supplied.** All Custom APIs determine the user from `zoho.loginuserid` (server-side). The widget sends **no** user identifier — it cannot impersonate another user.
- **Per-user data isolation.** Reads/writes are scoped `Employee.Email == zoho.loginuserid` (or insert for that employee). A user cannot read or modify another user's shift. Confirmed live (`WidgetGetState` returned only the caller's shift).
- **Onsite/remote not spoofable.** The IP used for the allow-list branch is server-derived (`zoho.ipaddress`), not client-supplied. Verified it returns the real client IP in Custom-API context.
- **No secrets in the client.** The widget uses the in-session Creator JS SDK (`ZOHO.CREATOR.DATA.invokeCustomApi`); there are no API keys, tokens, or refresh tokens in `client/`. Nothing sensitive shipped to the browser.
- **Embedding restricted.** Catalyst sends `X-Frame-Options: DENY` by default; framing is allowed only for the explicitly authorized embedding domains (the Creator builder domain and your portal domain).
- **Idempotent transitions.** Repeated calls are guarded: Check-In → `already_working`; Go-on-Break → `already_on_break`; Resume/Check-Out no-op without an open shift/break. No state corruption from replay.
- **No CRM exposure.** Widget wrappers never touch CRM.

---

## Findings & recommendations

### LOW — input validation on `WidgetGoOnBreak` (FIXED)
`breakType` and `note` come from the client. `breakType` was written to `Type_field` unvalidated.
**Fix applied:** server-side whitelist — only `"Break"` / `"Lunch"` accepted (else `invalid_break_type`). (`note` is bounded client-side via `maxlength=200`; it is stored, never rendered by the widget, so no widget XSS. Creator handles rendering escaping in reports.)
→ Re-paste the updated `WidgetGoOnBreak` (custom-apis.md §2).

### LOW — diagnostic endpoints (reviewed; KEPT by decision)
- **`WidgetWhoAmI` and `WidgetIpCheck` Custom APIs** — KEPT intentionally as troubleshooting tools (identity / "what IP does Zoho see for me"). **Accepted as low-risk** because they are OAuth2 + Portal-users scoped (require an authenticated portal user) and return **only the caller's own** `loginuserid` / IP — no cross-user data, no writes. The production IP logic lives inline in `WidgetCheckIn`; these are not dependencies. Condition for keeping them safely: they must stay **OAuth2/Portal-scoped (never Public Key)**.
- **Catalyst `timer_api` function** — genuine spike leftover (public, trivial JSON, no data). Local code removed + `catalyst.json` updated. Remote optional to delete (`catalyst functions:delete timer_api --remote`); harmless if left.

### LOW — shared-device localStorage flash
The widget instant-paints the last `WidgetGetState` snapshot from `localStorage` before the network returns. On a **shared** computer, user B could briefly see user A's cached Work/Break numbers before `WidgetGetState` corrects (sub-second). No sensitive PII (just elapsed times), and it self-corrects. Snapshot is cleared on Check-Out.
**Optional mitigation:** store `loginuserid` in the snapshot and skip the instant-paint if it can't be matched to the current user. Low priority for a personal-login portal.

### VERIFY — Custom API auth config
Confirm all production Custom APIs (`WidgetGetState` / `CheckIn` / `GoOnBreak` / `Resume` / `CheckOut`) are **OAuth2 + User Scope "Portal users"** — never **Public Key** (which would let anyone invoke them). The expiry function `WidgetExpireStaleShifts` should be a **scheduled** function, not a widget-invokable Custom API (it processes all users).

### OUT OF SCOPE — pre-existing app bugs (flagged, not ours)
The original button-triggered functions have latent issues (documented in `CONFIGURATION.md` §8): `TimesheetTimeIn` hardcodes a test email and sets `Added_User = zoho.loginuser`; `EmployeeIsWorking()` is date-scoped. These do not affect the widget's Custom APIs (which fixed them) but should be corrected in the app.

---

## Data handled
- Per-user attendance times (Time_In/Out, break in/out, scheduled times), IP address, coarse geolocation (city/region/country from ip-api), break notes. All scoped to the owning employee. No payment/credential data. Stored in Creator (the system of record).
