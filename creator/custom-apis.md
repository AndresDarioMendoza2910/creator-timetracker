# Creator Custom APIs — Deluge wrappers for the widget

These are the server-side functions the widget calls via `ZOHO.CREATOR.DATA.invokeCustomApi`.
Each is exposed as a **Custom API** with **OAuth2 auth, User Scope = "Portal users"** (so portal
employees can invoke them from the widget). See `CONFIGURATION.md` §4.

> **Status:** **Get-State = ✅ VERIFIED & deployed** (returns the confirmed contract — §1).
> Go-on-Break / Resume = drafts (verify field names + helper signatures against the live app).
> Check-Out = adaptation spec. Check-In = remote-attendance pattern decided (verify `zoho.ipaddress` in API context).

## Conventions (every wrapper)
1. Identity via **`zoho.loginuserid`** (= email). Never `zoho.loginuser` (in a Custom API it returns the org/account name, not the user).
2. **No `openUrl`** — return a status `Map` (JSON); the widget navigates client-side.
3. Detect the active shift **non-date-scoped**, excluding auto-closed ones:
   `Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc`
4. Return `serverNow` (Creator clock) so the widget can sync its offset.
5. **No CRM sync** — widget wrappers never write to the CRM `Attendances` module (decision). All `CreateCRMAttendance` / `UpdateCRMAttendanceBreakOut` / `BreakOutOpenBreaks`-CRM calls are omitted.

---

## 1. Get-State  →  Custom API `WidgetGetState` (GET)
New function. Returns everything the widget needs to rebuild the parallel timers.

```deluge
map WidgetGetState()
{
    response = Map();
    response.put("loginuserid", zoho.loginuserid);
    response.put("serverNow", zoho.currenttime.toString());
    response.put("serverNowMs", zoho.currenttime.toLong());
    response.put("serverDate", zoho.currentdate.toString());
    response.put("state", "idle");
    response.put("timesheetId", null);

    shifts = Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc;
    for each ts in shifts
    {
        response.put("timesheetId", ts.ID);
        response.put("timeIn", ts.Time_In.toString());
        response.put("timeInMs", ts.Time_In.toLong());

        breaksList = List();
        onBreak = false;
        for each timeBreak in ts.Break
        {
            br = Breaks[ID == timeBreak];
            bm = Map();
            bm.put("type", br.Type_field);
            if(br.Break_In != null)
            {
                bm.put("breakIn", br.Break_In.toString());
                bm.put("breakInMs", br.Break_In.toLong());
            }
            if(br.Break_Out != null)
            {
                bm.put("breakOut", br.Break_Out.toString());
                bm.put("breakOutMs", br.Break_Out.toLong());
            }
            if(br.Break_In != null && br.Break_Out == null) { onBreak = true; }
            breaksList.add(bm);
        }
        response.put("breaks", breaksList);
        response.put("state", if(onBreak, "on_break", "working"));
        break;  // latest open shift only
    }
    return response;
}
```
> Notes: **fetch-then-iterate** (`shifts = …; for each ts in shifts`) — the parser-safe idiom that matches the existing app functions; avoids `.get(0)`/`.count()` (tripped "invalid expression"). Returns **epoch ms** (`*Ms` via `.toLong()`) for clean JS parsing + readable strings for debugging. Explicit null checks on break timestamps. **Display datetime format: `dd-MMM-yyyy hh:mm:ss a`.**
> ⚠️ **Copy from the RAW file / a code editor, not a rendered markdown preview** — preview renderers can convert straight quotes to smart-quotes (breaks Deluge string literals → "improper statement").
**Example response** (use the `*Ms` epoch fields):
```json
{"loginuserid":"employee@example.com","serverNow":"09-Jun-2026 12:57:14 PM","serverNowMs":1781035034510,
 "serverDate":"09-Jun-2026","state":"working","timesheetId":1234567890000000000,
 "timeIn":"09-Jun-2026 11:35:00 AM","timeInMs":1781030100000,
 "breaks":[{"type":"Break","breakIn":"...","breakInMs":1781030160000,"breakOut":"...","breakOutMs":1781030220000}]}
```
**Widget uses:** `workMs = serverNowMs − timeInMs` (continuous); `breakMs = Σ(breakOutMs − breakInMs) + (on_break ? serverNowMs − openBreakInMs : 0)`; anchor to `serverNowMs`, tick via local delta.
**Confirmed:** `Time_In` is datetime; `.toLong()` epoch works; subform iteration (`for each in ts.Break` → `Breaks[ID==…]`) works; `state` computed correctly; idle when no open shift; returns the **latest** open shift when several exist.

---

## 2. Go on Break  →  Custom API `WidgetGoOnBreak` (POST, params: `breakType`, `note`)
New function (the existing break-in is a form workflow; this is its widget-callable equivalent, **no quota**).

```deluge
map WidgetGoOnBreak(string breakType, string note)
{
    response = Map();
    response.put("status", "not_working");

    // input validation — only accept known break types (server-side whitelist)
    if(breakType != "Break" && breakType != "Lunch")
    {
        response.put("status", "invalid_break_type");
        return response;
    }

    shifts = Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc;
    for each ts in shifts
    {
        // already on break? block double break-in
        alreadyOnBreak = false;
        for each timeBreak in ts.Break
        {
            br = Breaks[ID == timeBreak];
            if(br.Break_In != null && br.Break_Out == null)
            {
                alreadyOnBreak = true;
            }
        }
        if(alreadyOnBreak)
        {
            response.put("status", "already_on_break");
            return response;
        }

        nowT = zoho.currenttime;
        thisRow = Timesheets.Break();
        thisRow.Employee = ts.Employee;
        thisRow.Type_field = breakType;     // "Break" or "Lunch" (no quota in V1)
        thisRow.Date_field = zoho.currentdate;
        thisRow.Break_In = nowT;
        thisRow.Notes = note;
        rowCol = Collection();
        rowCol.insert(thisRow);
        ts.Break.insert(rowCol);

        // (No CRM sync — per decision.)

        response.put("status", "on_break");
        response.put("breakType", breakType);
        response.put("breakInMs", nowT.toLong());
        response.put("serverNowMs", nowT.toLong());
        break;  // latest open shift only
    }
    return response;
}
```
**Verify:** subform insert idiom (`Timesheets.Break()` + `ts.Break.insert(rowCol)`) matches the existing workflow ✅.

---

## 3. Resume Work  →  Custom API `WidgetResume` (POST)
Adapts `TimesheetBreakOut` (closes the open break).

```deluge
map WidgetResume()
{
    response = Map();
    response.put("status", "not_working");

    shifts = Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc;
    for each ts in shifts
    {
        breakout = zoho.currenttime;
        done = false;
        for each timeBreak in ts.Break
        {
            br = Breaks[ID == timeBreak];
            if(br.Break_In != null && br.Break_Out == null)
            {
                br.Break_Out = breakout;
                br.Break_Time = thisapp.ConvertTimeToText(br.Break_In.timeBetween(breakout));
                // (No CRM sync — per decision.)
                done = true;
            }
        }
        response.put("status", if(done, "working", "no_open_break"));
        response.put("serverNowMs", breakout.toLong());
        break;  // latest open shift only
    }
    return response;
}
```

---

## 4. Check Out  →  Custom API `WidgetCheckOut` (POST)
Ports `TimesheetTimeOut` into fetch-then-iterate: sets `Time_Out`, gross `Working_Time`, attendance
status, overtime; closes open breaks **CRM-free** (inline, no `BreakOutOpenBreaks`); no `openUrl`;
returns JSON. Reuses existing helpers `ConvertTimeToText` / `GetAttendanceStatus` /
`convertDurationToMinutes` / `ConvertMinutesToHHMM`.

```deluge
map WidgetCheckOut()
{
    response = Map();
    response.put("status", "not_working");

    shifts = Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc;
    for each ts in shifts
    {
        timeout = zoho.currenttime;
        ts.Time_Out = timeout;

        // close any still-open breaks (CRM-free)
        for each timeBreak in ts.Break
        {
            br = Breaks[ID == timeBreak];
            if(br.Break_In != null && br.Break_Out == null)
            {
                br.Break_Out = timeout;
                br.Break_Time = thisapp.ConvertTimeToText(br.Break_In.timeBetween(timeout));
            }
        }

        // gross working time (Time_In -> Time_Out) + attendance status
        timeBetweenTimeout = ts.Time_In.timeBetween(timeout);
        ts.Working_Time = thisapp.ConvertTimeToText(timeBetweenTimeout);
        ts.Attendance_Status = thisapp.GetAttendanceStatus(ts.Employee, ts.Time_In, timeout);

        // overtime (mirrors TimesheetTimeOut)
        empRec = ts.Employee;
        schedStartTime = empRec.Start_Time;
        scheduledMins = ifnull(empRec.Scheduled_Daily_Time, 0).toNumber();
        overtimeMinutes = 0;
        if(schedStartTime != null && scheduledMins > 0)
        {
            workDate = if(ts.Date_field != null, ts.Date_field, ts.Time_In.toDate());
            dateStr = workDate.toString("yyyy-MM-dd");
            schedStartDT = (dateStr + " " + schedStartTime.toString()).toDateTime("yyyy-MM-dd HH:mm:ss");
            effectiveStart = ts.Time_In;
            if(effectiveStart < schedStartDT)
            {
                effectiveStart = schedStartDT;
            }
            effectiveWorkedMins = thisapp.convertDurationToMinutes(effectiveStart.timeBetween(timeout));
            if(effectiveWorkedMins > scheduledMins)
            {
                overtimeMinutes = effectiveWorkedMins - scheduledMins;
            }
            scheduledWorkedMins = effectiveWorkedMins;
            if(scheduledWorkedMins > scheduledMins)
            {
                scheduledWorkedMins = scheduledMins;
            }
            ts.Scheduled_Time_Display = thisapp.ConvertMinutesToHHMM(scheduledWorkedMins);
        }
        else
        {
            ts.Scheduled_Time_Display = "00:00";
        }
        ts.Overtime_Minutes = overtimeMinutes;
        ts.Overtime_Display = thisapp.ConvertMinutesToHHMM(overtimeMinutes);
        ts.Overtime_Amount = (overtimeMinutes / 60.0).round(2);

        response.put("status", "checked_out");
        response.put("workingTime", ts.Working_Time);
        response.put("overtimeDisplay", ts.Overtime_Display);
        response.put("serverNowMs", timeout.toLong());
        break;  // latest open shift only
    }
    return response;
}
```
> If any helper call errors, the essential lines are `Time_Out` + `Working_Time` + the break-close loop; the overtime block can be trimmed.

---

## 5. Check In  →  Custom API `WidgetCheckIn` (POST) — remote pattern DECIDED
**Decided remote flow:** API decides onsite/remote. Onsite → insert Timesheet, return `{status:"checked_in"}`. Remote → return `{status:"remote_required", formUrl:"#Form:Remote_Attendance?…"}`; the widget then calls `ZOHO.CREATOR.UTIL.navigateParentURL(formUrl)` to send the user to the existing approval form (reuses it untouched). Still must verify `zoho.ipaddress` in Custom-API context.
Bug fixes carried in: employee lookup by `zoho.loginuserid` (NOT a hardcoded email); `Added_User = zoho.loginuserid` (NOT `zoho.loginuser`); no CRM; no `openUrl`.

### 5a. FIRST — verify `zoho.ipaddress` (diagnostic Custom API `WidgetIpCheck`, GET, Portal users)
Run this once as a portal employee BEFORE deploying the full Check-In. If `ipAddress` is the employee's real public IP, the onsite/remote branch is sound. If it's a Zoho datacenter IP, `zoho.ipaddress` doesn't work in Custom-API context → the widget must supply the IP instead.
```deluge
map WidgetIpCheck()
{
    response = Map();
    currentIP = zoho.ipaddress;
    response.put("ipAddress", currentIP);
    allowedIP = IP_Allowed_List[ip_address == currentIP && is_active == true];
    onsite = false;
    if(allowedIP != null && allowedIP.ip_address != null && allowedIP.ip_address != "")
    {
        onsite = true;
    }
    response.put("onsite", onsite);
    return response;
}
```

### 5b. Full Check-In (deploy after 5a confirms the IP)
```deluge
map WidgetCheckIn()
{
    response = Map();

    // already checked in? (latest open shift)
    open = Timesheets[Employee.Email == zoho.loginuserid && Time_Out == null && Attendance_Status != "No Check-Out"] sort by Time_In desc;
    for each o in open
    {
        response.put("status", "already_working");
        return response;
    }

    employee = Employees[Email == zoho.loginuserid];
    currentDate = zoho.currentdate;
    currentTime = zoho.currenttime;
    currentIP = zoho.ipaddress;

    // geo (best-effort)
    locationSummary = "";
    try
    {
        locResponse = invokeurl [ url : "https://ip-api.com/xml/" + currentIP  type : GET ];
        locXml = locResponse.toString();
        city = locXml.executeXPath("/query/city/text()");
        regionName = locXml.executeXPath("/query/regionName/text()");
        country = locXml.executeXPath("/query/country/text()");
        locationSummary = city + ", " + regionName + ", " + country;
    }
    catch (e)
    {
        locationSummary = "";
    }

    allowedIP = IP_Allowed_List[ip_address == currentIP && is_active == true];
    onsite = false;
    if(allowedIP != null && allowedIP.ip_address != null && allowedIP.ip_address != "")
    {
        onsite = true;
    }

    if(onsite)
    {
        decision = thisapp.calendar.getDayClassification(employee.ID, currentDate);
        insert into Timesheets
        [
            Employee = employee.ID
            Date_field = currentDate
            Day_Class = decision.get("dayClass")
            Scheduled_Time_In = employee.Start_Time
            Scheduled_Time_Out = employee.End_Time
            Time_In = currentTime
            Attendance_Status = "timed in"
            IP_Address = currentIP
            Location = locationSummary
        ];
        response.put("status", "checked_in");
        response.put("serverNowMs", currentTime.toLong());
        response.put("ip", currentIP);
    }
    else
    {
        encIP = encodeUrl(currentIP);
        encUser = encodeUrl(zoho.loginuserid);
        encLoc = encodeUrl(locationSummary);
        encEmployee = encodeUrl(employee.ID);
        encEmployeeType = encodeUrl(employee.Employee_Type);
        formURL = "#Form:Remote_Attendance?Added_User=" + encUser + "&IP_Address=" + encIP + "&Timein_Date=" + currentDate + "&Timein_Time=" + currentTime + "&Location=" + encLoc + "&Email_For_Dev_Do_Not_Touch=" + encUser + "&Employee=" + encEmployee + "&EmployeeType=" + encEmployeeType;
        response.put("status", "remote_required");
        response.put("formUrl", formURL);
        response.put("ip", currentIP);
    }
    return response;
}
```
> Notes: **`Added_User` is omitted** — it's an "Added User" system field that auto-captures the creator (the portal employee via the API session) and only accepts `zoho.loginuser`, so we don't set it; identity anchor is `Employee` (looked up by `zoho.loginuserid`). **No `attendance.ID`** — `insert into` return doesn't expose it cleanly ("Invalid collection object"); the widget re-fetches via `WidgetGetState` after check-in. `thisapp.calendar.getDayClassification` reused. Widget: on `remote_required`, call `ZOHO.CREATOR.UTIL.navigateParentURL(formUrl)`.

---

## 6. Expiry → `no_check_out` (scheduled Deluge function `WidgetExpireStaleShifts`)
Marks open shifts past `Scheduled_Time_Out + 2h grace` (schedule-based) as `Attendance_Status = "No Check-Out"`, closing any open breaks (CRM-free). `WidgetGetState` already excludes `"No Check-Out"`, so flagged shifts stop surfacing in the widget. **Run once manually to clear the test backlog; schedule hourly (Workflow → Schedules) for ongoing.** Standalone function (not widget-scoped; processes all users).

```deluge
map WidgetExpireStaleShifts()
{
    nowMs = zoho.currenttime.toLong();
    today = zoho.currentdate;
    graceMs = 7200000;   // 2 hours
    count = 0;

    openShifts = Timesheets[Time_Out == null && Attendance_Status != "No Check-Out"];
    for each ts in openShifts
    {
        expire = false;
        schedOut = ts.Scheduled_Time_Out;
        wDate = ts.Date_field;
        if(schedOut != null && wDate != null)
        {
            cutoff = (wDate.toString("yyyy-MM-dd") + " " + schedOut.toString()).toDateTime("yyyy-MM-dd HH:mm:ss");
            if(nowMs > (cutoff.toLong() + graceMs))
            {
                expire = true;
            }
        }
        else if(wDate != null && wDate < today)
        {
            expire = true;   // prior-day open shift with no usable schedule
        }

        if(expire)
        {
            for each timeBreak in ts.Break
            {
                br = Breaks[ID == timeBreak];
                if(br.Break_In != null && br.Break_Out == null)
                {
                    br.Break_Out = zoho.currenttime;
                    br.Break_Time = thisapp.ConvertTimeToText(br.Break_In.timeBetween(zoho.currenttime));
                }
            }
            ts.Attendance_Status = "No Check-Out";
            count = count + 1;
        }
    }
    response = Map();
    response.put("expired", count);
    return response;
}
```
> Epoch comparison (`cutoff.toLong() + graceMs`) avoids `addHour` ambiguity. Today's in-window shifts are NOT expired (cutoff is their own scheduled end + 2h). Fallback expires prior-day opens lacking a usable schedule.

## 7. App-wide execution logging (`App_Logs` + `tools.appLog` / `tools.logInfo` / `tools.logWarn` / `tools.logError`)
> The helper functions live in the **`tools`** function namespace and are called as `thisapp.tools.logInfo(...)` (same pattern as the existing `thisapp.calendar.*`). Names are camelCase: `appLog`, `logInfo`, `logWarn`, `logError`.
**Why:** Creator does NOT surface runtime execution logs for Custom APIs / standalone functions (its native Logs cover only Form Actions [failures only], Schedules, Email, Integration). `info()` only shows in the editor during manual test, not for API-invoked runs. So we keep **one general log form the whole app writes to** — not just the time tracker.

### Form `App_Logs`
Fields (Single Line unless noted):
| Field | Type | Notes |
|---|---|---|
| `Level` | **Dropdown** | options `INFO` / `WARN` / `ERROR` — must match the strings the helpers pass exactly (same case) |
| `Source` | Single Line | where it came from — function/workflow/module name (e.g. `WidgetCheckIn`, `TimesheetTimeOut`, `Breaks_OnSubmit`) |
| `Status` | Single Line | short outcome/code (optional) |
| `Message` | Multi Line | detail / error text |
| `User_Email` | Single Line | auto = `zoho.loginuserid` of the execution context |
| `Record_Id` | Single Line | related record id, optional (traceability) |
| `Logged_At` | Date-Time | auto = `zoho.currenttime` |

View via the auto-created report (sort `Logged_At` desc; filter by `Level`/`Source`). Build an admin page/report for it. Keep employees from reading it (no portal **View**); portal set needs **Add** (see permission note).

### Helpers (functions in the `tools` namespace)
```deluge
// Core — writes one row. NEVER throws (logging must not break callers).
void appLog(string level, string source, string status, string message, string recordId)
{
    try
    {
        insert into App_Logs
        [
            Level = level
            Source = source
            Status = status
            Message = message
            User_Email = zoho.loginuserid
            Record_Id = recordId
            Logged_At = zoho.currenttime
        ];
    }
    catch (e)
    {
        // swallow — logging must never break the caller
    }
}

void logInfo(string source, string status, string message)
{
    thisapp.tools.appLog("INFO", source, status, message, "");
}
void logWarn(string source, string message)
{
    thisapp.tools.appLog("WARN", source, "", message, "");
}
void logError(string source, string message)
{
    thisapp.tools.appLog("ERROR", source, "error", message, "");
}
```

### Usage (anywhere in the app) — always `thisapp.tools.<fn>`
- Widget write APIs — one line before the final `return response;`:
  - `WidgetCheckIn`:  `thisapp.tools.logInfo("WidgetCheckIn", response.get("status"), currentIP);`
  - `WidgetGoOnBreak`: `thisapp.tools.logInfo("WidgetGoOnBreak", response.get("status"), breakType);`
  - `WidgetResume`:   `thisapp.tools.logInfo("WidgetResume", response.get("status"), "");`
  - `WidgetCheckOut`: `thisapp.tools.logInfo("WidgetCheckOut", response.get("status"), "");`
- Any error path (wrap risky logic): `try { ... } catch (e) { thisapp.tools.logError("TimesheetTimeOut", "" + e); }`
- A form/workflow: `thisapp.tools.logInfo("Breaks_OnSubmit", "break_in", input.Type_field);`
- With a related record: `thisapp.tools.appLog("INFO", "SomeFn", "ok", "note", recordId.toString());`

(GetState is a frequent read — leave it unlogged to avoid noise, or log only on error.) This logs intentional events + explicit `logError` calls, and crashes where you add a try/catch wrapper.

**Crash-logging pattern for a `map` function** — wrap the body in `try { ... return response; } catch (e) { logError; return response; }`, set `response.put("status","error")` as the default at the very top, and add a **trailing `return response;` AFTER the catch block** (Deluge doesn't treat try/catch returns as a guaranteed exit → otherwise errors with *"Missing return statement: Provide MAP expression to return"*). Rename any inner catch var (e.g. the geo lookup's) so two `catch (e)` don't clash (function-scoped vars).

⚠️ **Permission note:** a Custom API runs as the portal user, so `insert into App_Logs` runs as them. If portal-user logs don't appear, grant the **Portal permission set → Add** on `App_Logs` (keep **View** off). The helpers' try/catch means a missing permission fails silently rather than breaking the action. (Server-side/scheduled executions run as the app and can write regardless; `User_Email` there reflects that context, which may be the app owner or blank.)

## Open questions
- ✅ CRM sync: **none** anywhere in the widget wrappers (decided).
- `Time_In` field type (datetime vs time) — confirm for elapsed math.
- Check-In remote flow (above).
