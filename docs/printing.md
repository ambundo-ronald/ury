# Printing kitchen tickets and bills from the cloud

When URY runs on a cloud server, the server cannot reach printers on the
restaurant's network. The **URY POS Windows app** solves this: installed on a
PC at the restaurant, it collects kitchen tickets (KOTs) and bills from the
site and prints them on that PC's printers.

- The PC only makes outgoing HTTPS connections. No VPN, no port forwarding,
  no print server.
- It prints from the tray icon even when the POS window is closed and nobody
  is signed in to the POS.
- If the PC or the internet is down, tickets wait on the site and print when
  it is back (tickets older than 12 hours are not printed).
- Nothing is lost silently: a ticket that does not print shows on the
  cashier's POS with a **Reprint** button.

Printers not handled by an agent keep printing through a print server (CUPS)
as before, and their failures now show on the POS too.

## Setting up

### 1. The printers in Windows

On the PC, install each kitchen, bar and bill printer in Windows with its
own driver (for example the XPrinter driver), whether it is on the network
or plugged in by USB. Give network printers a fixed IP address on the router
so they do not move. Print a Windows test page to check each one.

The PC must stay switched on during service. Set it never to sleep.

### 2. The printers in URY

Each printer used in a production unit, room or POS Profile is a
**Network Printer Settings** record (Desk > Network Printer Settings > New).
For a printer printed by the app, these fields are not used, but Frappe
requires them:

- **Name:** what URY shows, e.g. `Kitchen Printer`.
- **Server IP** and **Port:** leave `localhost` and `631`.
- **Printer Name:** the list only fills from a print server (CUPS), so on a
  cloud site it is empty. Click **Type Printer Name** and enter any name,
  for example the Windows name of the printer.

Pick these printers as usual:
- **Kitchen tickets:** URY Production Unit > printers, with "KOT print" ticked
  and a KOT print format.
- **Bills:** POS Profile (or URY Room) > printers, with "Bill" ticked and
  print type "network".

### 3. The print agent

1. Desk > **URY Print Agent** > New. Name it after the PC (e.g. `POS-PC`)
   and choose the branch.
2. Install `URY POS Setup.exe` on the PC and open it. The **Printing** window
   opens.
3. In the agent form, click **Pair the Windows App**. Type the site address,
   the agent name and the 6-digit code into the app, then click **Pair**. The
   code works once and expires in 10 minutes.
4. The app lists **Printers on this PC**, and so does the agent form
   ("Printers Found On This PC"). In the agent's **Printers** table, add a
   row for each URY printer with its Windows name exactly as listed.
5. In the app, choose a printer and click **Test print**.

### 4. The POS screen

The POS window opens on the **station sign-in** page, where staff enter their
PIN, and fills the whole screen with no title bar, menus or address bar. After
the PIN, staff get the normal URY POS. To change this, open the **Printing**
window, section **POS screen**:

- **Opens on:** Station sign-in (PIN) or Normal login (email and password).
  On the station page, **Staff login** also leads to the normal login.
- **Full screen:** on or off. **F11** switches it while the POS is open, and so
  does tray menu > POS full screen.

- **Keyboard button:** a round blue button floats on the left edge of the POS.
  Tap it to open the Windows On-Screen Keyboard, which types into the box
  being edited; close the keyboard with its ✕. Drag the button to move it,
  and it stays where it was left. Switch it off in the Printing window or the
  tray menu.

On a touch screen, Windows can also pop up its touch keyboard by itself when
a text box is tapped. If Settings > Time & language > Typing > Touch keyboard
is not shown, run this once in PowerShell on the POS PC, as the staff user:

```powershell
reg add HKCU\Software\Microsoft\TabletTip\1.7 /v TouchKeyboardTapInvoke /t REG_DWORD /d 2 /f
```

If the site cannot be reached, the window shows "Can't reach URY" and tries
again every 15 seconds instead of a blank page.

To lock the PC to the POS alone (no desktop or other apps), set up Windows
**Assigned Access** (kiosk mode) for a dedicated Windows user, with URY POS
as its app.

After pairing, the app starts with Windows (tray menu > Start with Windows).
Closing the POS window keeps printing; only tray menu > Quit stops it.

A printer belongs to one agent. If a second PC should print, give it its
own agent and printers.

## When something does not print

The cashier's POS shows **Printing problems**:

| What it says | What to do |
|---|---|
| A ticket and the printer's error | Fix the printer (paper, power, cable), then **Reprint**. **Dismiss** if it was handled another way. |
| "The print PC is not connected" | The PC is off, asleep, offline, or the app was quit. Tickets wait and print when it is back. |
| "N waiting to print" | Same as above, or the app is still catching up. |

Waiters do not see these alerts; cashiers and managers do.

Every job is listed in Desk > **URY Print Job** (status, printer, error,
attempts). Jobs older than 30 days are deleted daily.

To stop a PC printing (lost or replaced), open its agent and click
**Unpair**, or untick **Enabled**.

## For developers

| Part | Where |
|---|---|
| Queue and routing (agent or CUPS) | `ury/ury/printing/queue.py` |
| Agent endpoints (`pair`, `poll`, `report`) | `ury/ury/printing/agent.py` |
| POS alerts (`get_print_problems`, `retry_print_job`, `dismiss_print_job`) | `ury/ury/printing/api.py`; POS: `pos/src/components/PrintAlerts.tsx` |
| KOTs, KOT reprint, waiter slips, bills | `ury_kot.py`, `ury_kot_reprint.py`, `ury_waiter_print.py`, `ury_print.network_printing` |
| Windows app | `desktop/` (Electron) |

- **How the agent works:** it polls `poll` every 3 seconds, sending its token
  in the `X-URY-Agent-Token` header.
- **Claimed jobs:** `poll` claims up to 10 jobs for the agent's printers and
  returns each as a standalone HTML page. A job claimed but not reported
  within 120 seconds is offered again.
- **No double printing:** the app remembers what it printed, so a job offered
  again only gets confirmed, not printed twice.
- **Pairing:** a one-time code, stored hashed, like station activation. The
  agent's token is stored hashed on the site and encrypted with Windows DPAPI
  on the PC.

Tests: `ury.ury.printing.test_print_agent` (server), `cd desktop && npm test`
(agent loop).

## Updates

Installed apps update themselves from this repository's `desktop-latest`
GitHub release:

- They check an hour after starting, then every 4 hours.
- A new version downloads in the background while printing carries on.
  Usually only the changed parts download, not the whole installer.
- **When it installs:** installing restarts the app and pauses printing for
  about 10 seconds, so it never happens during service by itself. It installs:
  - between 3 and 5 a.m. local time, unless a ticket is printing;
  - when the app is quit or Windows restarts;
  - when someone clicks **Restart to update**, in the tray menu or the
    Printing window.
- Tickets sent during the restart wait and print right after.

### Releasing a new version

1. Bump `version` in `desktop/package.json` and commit.
2. Push a matching tag: `git tag desktop-v1.0.1 && git push origin desktop-v1.0.1`.

The **Desktop app release** workflow (`.github/workflows/desktop-release.yml`)
then:
- runs the tests;
- builds the installer;
- publishes a `desktop-vX.Y.Z` release;
- replaces the installer and `latest.yml` on `desktop-latest`.

Download installers for new PCs from `desktop-latest` too.

A local build (`cd desktop && npm install && npm run dist`, output in
`desktop/dist`) has no update feed and never updates itself. Use it only for
testing.

The builds are not code-signed, so Windows SmartScreen warns on the first
install. Click "More info" > "Run anyway". Updates install without the
warning.
