# Time Tracker Widget — Configuration Reference

**Purpose:** the durable, authoritative record of *how everything is configured and **why***, across Catalyst, Creator, authentication, and the Custom APIs. Every entry states **what it's set to**, **why**, and **why not the alternative**. Replace the `<placeholders>` below with your own project's values.

---

## 0. Quick-reference table (fill in for your deployment)

| Thing | Value |
|---|---|
| Catalyst project ID | `<PROJECT_ID>` |
| Catalyst org / env ID | `<ORG_ID>` |
| Catalyst environment | Development |
| Data center | your DC (e.g. US `.com`) |
| Catalyst project domain | `<project-domain>.development` |
| Widget (client) URL | `https://<project-domain>.development.catalystserverless.com/app/index.html` |
| Creator app link name | `<app-link-name>` |
| Creator owner / scope | `<account-owner>` |
| Authorized iFrame domains (Catalyst) | the Creator builder domain (e.g. `creatorapp.zoho.com`) + your `<portal-domain>` |
| Verified identity handle | **`zoho.loginuserid`** (= user email) — NOT `zoho.loginuser` |

---

## 1. Roles of each platform (the big picture)

- **Zoho Catalyst = static frontend hosting ONLY.** It serves the widget's HTML/JS/CSS via Web Client Hosting. Nothing else in the production design.
- **Zoho Creator = backend + data + identity.** All server-side logic runs as Deluge inside **Custom APIs**, executed as the logged-in portal user. The `Timesheets` form/`Breaks` subform are the data + source of truth.
- **The widget (in Catalyst) talks to Creator** via the Creator Widget JS SDK (`ZOHO.CREATOR.DATA.invokeCustomApi`), in the user's portal session.

> **Why this split:** it satisfies both original goals at once — deploy-based updates with no re-zip (Catalyst hosting) AND cross-device, per-user, server-verified state (Creator, which enforces identity natively). See §5.
>
> **Why NOT Catalyst Functions + Catalyst Cache for the backend (the original direction considered):** server-side identity could not be obtained on Catalyst for a Creator-embedded widget without an OIDC login step (see §5 rejected alternatives), whereas Creator Deluge already knows the user (`zoho.loginuserid`). Creator also can't use the generic Data APIs for portal users (§3.2), so Custom APIs are required regardless. Result: the Catalyst backend/Cache adds complexity with no identity benefit. **The Advanced I/O function (`timer_api`) and Catalyst Cache were Phase-0 spike artifacts only and are NOT part of the production design.**

---

## 2. Zoho Catalyst

### 2.1 Project & config files
Three config files, each in a specific location (verified against docs):
- **`catalyst.json`** (project root) — declares `functions` + `client` source dirs.
- **`client-package.json`** (client dir root) — `name`, `version`, `homepage` (entry file). Web client config.
- **`catalyst-config.json`** (each function dir) — `deployment.{name,stack,type,env_variables}` + `execution.main`. *(Only relevant if a function exists; not needed in the production design.)*

> Why this matters: the config-file naming is easy to confuse. Confirmed: function config is `catalyst-config.json`, **not** `app-config.json`.

### 2.2 Web Client Hosting (the frontend)
- **What:** "Basic" web app = `index.html` + `main.css` + `main.js` + `client-package.json`. Entry declared via `homepage`. Served at `…/app/index.html`. One web app per project.
- **Why Catalyst hosting:** enables `catalyst deploy` updates with no manual ZIP re-upload in Creator (a locked goal).
- **Why External (in Creator) pointing here:** see §3.1.

### 2.3 Advanced I/O Functions — **spike-only, not in production**
- Researched and used for the Phase-0 spike (`timer_api`, `node18`, `type: advancedio`, Express, URL `/server/<fn>/`, 30s timeout).
- **Why Advanced I/O over Basic I/O (if a function were ever needed):** Basic I/O is String-output only, no custom response headers/type, GET-priority params — unusable for clean JSON/CORS APIs. Advanced I/O gives native req/res + headers + Express.
- **Why not in production:** all backend logic lives in Creator Custom APIs (§1). No Catalyst function is required for the time tracker.

### 2.4 Authentication (Native Catalyst Authentication)
- **What:** a Native Catalyst Authentication method is set up on the project.
- **Why:** it is the **prerequisite that unlocks the Authorized Domains / Whitelisting section** (§2.5). The Whitelisting UI only appears after ≥1 auth type is configured.
- **Why it's safe:** enabling auth does **not** force login or block public access to the hosted client by default (public access is governed separately by Public Signup, which we leave off). The static widget stays publicly loadable.
- **Why NOT used for identity:** Catalyst's "current user" requires a separate Catalyst login session that the Creator iframe doesn't carry (`getCurrentUser()` returned `null`). Identity comes from Creator instead (§3.3).

### 2.5 Authorized Domains (iFrame + CORS) — **critical**
- **What:** Catalyst console → Cloud Scale → Authentication → Whitelisting → **Authorized Domains**. Each embedding domain is added with **iFrame** (and CORS) enabled. Domain format = **bare host incl. subdomain, no scheme, no wildcard** (e.g. `creatorapp.zoho.com`).
- **Authorized so far:**
  - `creatorapp.zoho.com` — how the **admin/builder** views the app.
  - **`<portal-domain>`** — the custom portal domain portal users access (different from the admin's builder domain). Must stay authorized or portal users get "refused to connect".
- **Why required:** Catalyst Web Client Hosting sends **`X-Frame-Options: DENY`** by default → browsers refuse to frame the widget anywhere. Authorizing a domain relaxes framing for it.
- **Why per-domain (and why every access domain must be listed):** the admin and portal users reach the app via different domains; each must be authorized independently. Missing the portal domain = widget won't load for employees.
- **Why NOT switch the frontend to AppSail (to control headers ourselves):** would deviate from the locked Web Client Hosting decision; Authorized Domains solves framing within the chosen model.

### 2.6 CORS in code
- In-code CORS headers on a Catalyst function **do** work (verified in spike), though Zoho docs steer toward console whitelisting. *(Moot in production since no Catalyst function is used.)*

### 2.7 Deploy
- `catalyst deploy` (whole project) or `catalyst deploy --only client` / `--only functions`. CLI auth persists locally after `catalyst login`; project linked via `catalyst project:use <id> --org <org>` (writes `.catalystrc`).
- Org flag was needed non-interactively: `--org <ORG_ID>`.

---

## 3. Zoho Creator

### 3.1 Widget registration (External hosting)
- **What:** the widget is registered in Creator with **Hosting = External**, Index URL = the Catalyst client URL (§0).
- **Why External (not Internal/ZIP):** updates ship via `catalyst deploy` with no re-zip/re-upload (a locked goal). Internal hosting would require repackaging a ZIP for every change.
- **Constraint:** JS-API widgets do **not** work on *published* pages — use a normal app/portal page.

### 3.2 Customer Portal & portal users — **critical constraint**
- **ALL employees are Creator portal (customer-portal) users** (confirmed), not org users. → every Custom API is scoped to "Portal users".
- **Portal users CANNOT use the generic Data / JS-SDK APIs** (`addRecords`/`getRecords`/`updateRecords`). Docs: *"Customers cannot trigger API calls and therefore not use APIs for data manipulation."*
- **Portal users CAN invoke a Custom API** — but only if its OAuth2 **User Scope = "Portal users"**, and **only from within a widget**.
- **Consequence:** every widget↔server operation MUST be a Custom API scoped to Portal users (§4). This is *the* reason the integration is shaped the way it is.

### 3.3 Identity — use `zoho.loginuserid`, never `zoho.loginuser`
- Server-side, inside Custom-API Deluge: **`zoho.loginuserid` = the user's email** and resolves to the *actual logged-in (portal) user* — verified.
- **`zoho.loginuser` returned the org/account name** (not the user) in the Custom-API context — do NOT use it for identity.
- **Why this matters:** the original `TimesheetTimeIn` sets `Added_User = zoho.loginuser` → via the widget path that would write the org name. All widget-invoked Deluge must use `loginuserid` for identity (consistent with `TimesheetTimeOut`/`BreakOut`/`EmployeeIsWorking`).
- `getInitParams().loginUser` (client-side) is a **claim only** — never authorize on it; the server uses `loginuserid`.

---

## 4. Custom APIs (the integration layer)

### 4.1 Why Custom APIs (and not the alternatives)
- **Why Custom APIs:** the only documented way for **portal users** to run server-side logic with their identity, from a widget (§3.2). Each runs Deluge as the portal user → `zoho.loginuserid` preserved.
- **Why NOT the generic Data APIs (`addRecords`/`getRecords`):** blocked for portal users (§3.2).
- **Why NOT call Deluge functions directly:** there is no documented way to invoke a bare Deluge function from a widget; it must be wrapped as a Custom API.
- **Why NOT external REST + a stored OAuth token:** that runs as the *token owner*, not the live user — breaks per-user identity.

### 4.2 Auth & scope
- **Auth type: OAuth2.** **User Scope: "Portal users".**
- **Why OAuth2 + Portal users (not Public Key):** Public Key = "anyone can invoke" → loses per-user identity. OAuth2 with Portal-users scope = authenticated, per-user, invokable from a widget.
- **Why "Portal users" scope specifically:** other scopes (Admin only / Selective / All) cover org users but **not** portal users. There is **no single scope** covering both org admins and portal users — so scope to "Portal users" for the real employees. (Admins test via a portal-user account.)
- User Scope is set at creation (Request tab) and only editable via ⋯ → Edit API (not in the detail view).

### 4.3 Invocation (from the widget)
- `ZOHO.CREATOR.DATA.invokeCustomApi({ api_name, http_method, payload })` → runs in the user's portal session, returns the API's value.

### 4.4 Deluge conventions for every wrapper
1. Use **`zoho.loginuserid`** for identity (never `zoho.loginuser`).
2. **Remove `openUrl(...)`** — it doesn't execute outside the UI; the widget navigates client-side.
3. **`return` a JSON/string status** the widget can read.
4. Detect the active shift **non-date-scoped**: `Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null] sort by Time_In desc` (NOT `EmployeeIsWorking()`, which is date-scoped and breaks overnight shifts).
5. **No CRM sync (decided):** widget wrappers never write to the CRM `Attendances` module. All `CreateCRMAttendance` / `UpdateCRMAttendanceBreakOut` / CRM-side break-closing is omitted (incl. replacing `BreakOutOpenBreaks` with a CRM-free inline break-close on Check Out).

### 4.5 Custom API inventory
| api_name | Purpose | Scope | Status |
|---|---|---|---|
| `WidgetWhoAmI` | returns `zoho.loginuserid` (identity spike) | Portal users | ✅ created, verified for portal user |
| Check In | wrap `TimesheetTimeIn` logic (loginuserid, no openUrl, JSON) | Portal users | planned |
| Go on Break | insert `Breaks` subform row with **user-selected `Type_field`** (passed as payload param); runs break-in logic | Portal users | planned |
| Resume Work | wrap `TimesheetBreakOut` logic | Portal users | planned |
| Check Out | wrap `TimesheetTimeOut` logic | Portal users | planned |
| Get-State | return open Timesheet + its `Breaks` for the widget to reconstruct timers | Portal users | planned |

---

## 5. Identity & security model (why server-verified, and rejected alternatives)

- **Rule:** never trust client-supplied identity. Authorize/key storage on the **server-verified `zoho.loginuserid`** inside Custom-API Deluge.
- **Rejected alternatives (and why):**
  - **Trust `getInitParams().loginUser`** — it's a client claim; spoofable. ❌
  - **Catalyst `getCurrentUser()`** — returns null in the Creator iframe (needs a separate Catalyst login). ❌
  - **Catalyst Embedded/Hosted auth** — forces a second login + possible identity mismatch. ❌
  - **Catalyst Connectors** — authenticate as a service account, not the end-user. ❌
  - **Zoho OIDC flow we operate** — only documented server-verified path on *Catalyst*, but may force a visible login/consent in the iframe (unproven silent flow). Unnecessary once we lean on Creator. ❌
  - **Public Key Custom APIs** — anyone can invoke; no per-user identity. ❌

---

## 6. Creator data model (config dependencies — brief)
- **`Timesheets` form** (source of truth + live state). Key fields: `Employee` (lookup→`Employees`), `Date_field`, `Time_In`, `Time_Out`, `Attendance_Status`, `Scheduled_Time_In`/`Scheduled_Time_Out`, `Working_Time` (gross), `Overtime_*`, `IP_Address`, `Location`, `Day_Class`, `CRM_ID`.
- **`Break` subform** of `Timesheets`: `Type_field`, `Date_field`, `Break_In`, `Break_Out`, `Break_Time`, `Notes`. `Break_In`=break start, `Break_Out`=break end (resume).
- **`Employees`**: `Email`, `Start_Time`, `End_Time`, `Scheduled_Daily_Time`, `Employee_Type` (Management→CRM Contacts, Staff→CRM Candidate).
- **`IP_Allowed_List`**: onsite vs remote attendance branching.
- **CRM `Attendances`**: synced from the Deluge (breaks list, time in/out).

---

## 7. Behavioral config decisions (rationale)
- **Timers run in PARALLEL, no deduction:** work timer is continuous/gross (`Time_In`→now, keeps counting during breaks); break timer runs in parallel. Matches the official gross `Working_Time`. (Supersedes the originally-locked "work pauses on break.")
  - **Reconstruction (validated):** `workMs = serverNowMs − timeInMs`; `breakMs = Σ(breakOutMs − breakInMs) + (on_break ? serverNowMs − openBreakInMs : 0)`. Widget anchors base to Creator `serverNowMs` at load, then ticks via local delta (`Date.now()`) — smooth + clock-skew-immune.
  - **Timestamp format:** Creator `.toString()` gives display `dd-MMM-yyyy hh:mm:ss a` (not JS-parseable). `WidgetGetState` therefore also returns **epoch ms** via `.toLong()` (`serverNowMs`/`timeInMs`/`breakInMs`/`breakOutMs`) — the widget uses the epoch fields. Verified shape in `creator/custom-apis.md` §1.
- **Break type CHOICE preserved (confirmed):** "Go on Break" lets the user pick the break type (mirrors the current Break-form behavior). The chosen `Type_field` is passed to the Go-on-Break Custom API as a payload param; the widget surfaces the types as a choice. **`Type_field` values = `"Break"` and `"Lunch"`.** A **Note** field is included (optional, → subform `Notes`). **Quota enforcement = SKIPPED for V1** (and the existing workflow's `maxedBreak` check keys on `"15mins"`/`"1hr"` which don't match "Break"/"Lunch" — effectively dead anyway).
- **Clock authority:** Creator server time; the widget syncs a one-time offset on load (`skew = creatorNow − Date.now()`) and stamps transitions with Creator time.
- **Live-state persistence:** the open Creator Timesheet record (+ its Breaks) IS the live state; reconstructed on load. No Catalyst Cache (so no 48h TTL).
- **Expiry → `no_check_out`:** schedule-based. A scheduled Deluge job flags open shifts where `creatorNow > Scheduled_Time_Out + 2h grace` as terminal status `no_check_out`. Overnight shifts restore up to their own assigned end.
- **Widget UI (final):** full-bleed **responsive** (fills the iframe; `html/body height:100%`, card `flex:1`, padding `clamp(24px,5vw,56px)`) — relies on the Creator widget iframe having a defined height. **Three layout regimes** (viewport media queries on the iframe; markup grouped into `.info` = date+timers and `.controls` = buttons): **portrait** (stacked, centered — default), **landscape** (`min-width:640px & min-aspect-ratio:5/4 & min-height:201px` → info | controls side by side), **strip** (`max-height:200px`, any width incl. mobile → one compact row, `flex-wrap` so it never clips, date hidden, inline controls, smaller timers). **The landscape `min-width:640px` guard is essential for MOBILE** — without it a narrow phone viewport that is wider-than-tall falls into the wide landscape layout and the button clips off-screen. So: narrow + tall → portrait; narrow + short → strip (wraps the 2 working-state buttons to a 2nd line if needed); wide + short → strip; wide + tall → landscape. Verified (JS-measured, no overflow) at 375×180 idle+working, 390×700 portrait, 760×420 landscape. **No card border or radius** (full-bleed, square — removed 2026-07-13; incl. the strip override). Opacity-only fade-in (no translate — a `translateY` caused a load-time scrollbar). Buttons `border-radius:15px`. Button hierarchy: Check In / Go on Break / Resume = terracotta **primary**; Check Out = **secondary** (1px outline; deliberate, avoids accidental shift-end). Break label shows the active type (BREAK/LUNCH) while on break; Work timer hidden during break. No logo header, no status row, no `<form>`, no em-dashes.

---

## 8. Known pre-existing bugs in the Creator app (fix separately)
- `TimesheetTimeIn` hardcoded a test email in `Employees[Email == "..."]` (test artifact) → must use `zoho.loginuserid`.
- `TimesheetTimeIn` sets `Added_User = zoho.loginuser` → would write the org name via the widget path → use `loginuserid`.
- `EmployeeIsWorking()` is date-scoped to today → misses overnight shifts → use the non-date-scoped open-shift query.

---

## Open config items to finalize
- ✅ Portal domain = `<portal-domain>`. ✅ All employees portal users. ✅ Grace = 2h. ✅ Break types = "Break"/"Lunch". ✅ Quota = skipped. ✅ Note field = included.
- ✅ **DECIDED** — Check In remote flow: API returns `remote_required` + `Remote_Attendance` form URL; widget navigates the parent via `ZOHO.CREATOR.UTIL.navigateParentURL(...)` to the existing approval form (reused untouched). Onsite path inserts directly.
- ✅ **VERIFIED:** `zoho.ipaddress` inside a widget-invoked Custom API returns the **end-user's real public IP** (tested against `IP_Allowed_List` → `onsite:true`). Onsite/remote branch in `WidgetCheckIn` is sound; no widget-supplied IP needed.
- ✅ **VERIFIED:** `Time_In` is a **datetime** field (`.toLong()` epoch works; reconstruction uses epoch ms).
