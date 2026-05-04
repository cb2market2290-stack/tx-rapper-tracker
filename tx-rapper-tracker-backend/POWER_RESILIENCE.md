# Power + connectivity resilience runbook

The site runs on a Mac Pro behind a Cloudflare Tunnel. As long as the
Mac stays on AND has internet, the site stays up. Three failure modes
will take you down:

1. **Power outage at home.** Mac powers off → backend unreachable.
2. **Internet outage at home.** Mac's still on but Cloudflare Tunnel
   can't establish.
3. **Mac sleep / auto-update reboot.** Self-inflicted; entirely
   preventable.

This runbook covers the cheap, durable mitigations for all three.
None of them are dependencies — the site already works without any
of this — but each one buys real reliability for very little money.

---

## 1. Power outage → UPS

**Recommendation: APC Back-UPS BE600M1, ~$80 on Amazon.** Or any 600VA
class UPS with a USB connection.

What this gets you:
- ~30-45 minutes of runtime on the Mac Pro alone (or ~15 min if you
  also plug in a monitor + the cable modem)
- Surge protection (Mac Pro is too expensive to leave on a bare wall
  outlet)
- macOS sees the UPS via USB and shows battery status in System
  Settings → Energy

**What to plug into the UPS battery side:**
- Mac Pro
- Cable modem / fiber ONT
- Wi-Fi router (if you tether for the internet outage scenario below)

**What NOT to plug in:**
- Monitor (drains the battery; you don't need it to display anything
  during an outage)
- Speakers, printers, anything that isn't critical to keeping the
  site reachable

**Setup once installed:**
```
System Settings → Energy
  ☑  Start up automatically after a power failure
  ☑  Wake for network access
  Disable "Put hard disks to sleep when possible" — Postgres dislikes it
```

The "Start up automatically after a power failure" box is what makes
the UPS work as automated recovery. When the outage ends, the Mac
boots, launchd starts the backend (Phase 3.5.1 plist), Cloudflare
Tunnel reconnects on its own. Total downtime: time-of-outage + ~60s
boot.

---

## 2. Internet outage → tethered hotspot fallback

Most home outages aren't power — they're the cable provider. ISP
goes down for 30-60 min mid-afternoon, you get an alert, you flip
the Mac to your phone's hotspot manually:

```
On the iPhone: Settings → Personal Hotspot → On
On the Mac: Wi-Fi menu → connect to your phone's hotspot name
```

Cloudflare Tunnel auto-reconnects within a few seconds of new
internet — `cloudflared` is its own daemon and re-establishes the
tunnel automatically.

**This is a manual fallback.** Automating it (Mac auto-switches when
home internet drops) is possible but fiddly — `networksetup` +
`scutil` scripts, prone to flapping. The 5-minute manual failover
during the once-a-quarter outage is a better trade than a script
that flaps in and out at 2am.

For a permanent always-on fallback you'd add a 5G failover router
(~$200) — but at that point you're closer to the cost of moving to
Hetzner anyway.

---

## 3. Mac sleep / auto-update reboot → preventive settings

Mac will sleep + macOS will reboot for security updates by default.
Both kill the site.

### Sleep settings

```
System Settings → Energy
  Prevent automatic sleeping when the display is off:  ☑
  Wake for network access:                              ☑
  When connected to a power adapter:
    Display goes off after: 30 minutes                  (irrelevant)
    Computer sleep:         Never                        ← critical
```

The "Computer sleep: Never" knob is the one. The display can sleep
freely (no impact on backend uptime); the computer must not.

### macOS auto-update

```
System Settings → General → Software Update → Automatic Updates
  Check for updates:                          ☑
  Download new updates when available:        ☑
  Install macOS updates:                      ☐  ← turn OFF
  Install application updates from App Store: ☑
  Install Security Responses & system files:  ☑
```

The "Install macOS updates" toggle is what schedules a reboot. With
that off, macOS still notifies you about pending updates but waits
for you to install manually. Once a month, when you have 10 minutes,
install via System Settings → Software Update with the launchd
plist already in place to bring the backend back up after the reboot.

### Login items

Verify the launchd backend agent loads at login:
```
launchctl list | grep com.txrappertracker.backend
```

If it isn't listed, run `bash scripts/install-launchd-backend.sh`
once — it sets `RunAtLoad: true` so the backend starts on every
login + reboot.

---

## 4. Monitoring → know fast when something's down

Phase 3.5.4 shipped `GET /api/health/deep` — point an external
uptime monitor at it. **Free options:**

- **UptimeRobot** (free tier: 50 monitors, 5-min interval).
  Setup: create monitor → URL `https://<your-domain>/api/health/deep`
  → expect HTTP 200 → email alert on failure.

- **Better Stack / Better Uptime** (free tier: 10 monitors, 3-min
  interval). Slicker UI; fewer monitors.

- **Cloudflare Health Checks** (free, native to your existing
  Cloudflare account). Setup: Cloudflare dashboard → Traffic →
  Health Checks → New → URL path `/api/health/deep` → expect
  HTTP 200.

Whichever you pick, the alert should email you AND text your phone
(SMS / Pushover / Telegram). A 30-minute outage is fine; a 4-hour
outage you didn't notice is a lost weekend.

---

## 5. ISP terms of service → know your contract

Most US residential ISP contracts include a clause prohibiting
"hosting servers" — Comcast / Spectrum / AT&T all have this in
their fine print. They almost never enforce it for a low-traffic
personal site. They sometimes enforce it for high-bandwidth or
high-traffic sites that show up on their abuse heuristics.

Cloudflare Tunnel materially helps here: from your ISP's
perspective, your Mac is making a single outbound TCP connection
to Cloudflare. There's no inbound port-80/443 listening. You look
identical to any other "always connected" home device.

**Triggers that have actually gotten people letters:**
- Sustained high upload (dozens of Mbps for hours) — this is the
  most common one
- Listed in DNS for a high-reputation domain (someone runs a port
  scan)
- Spam/abuse coming from your IP

You're protected from #2 and #3 because Cloudflare proxies
everything. You're vulnerable to #1 if your site goes viral.

**At what point do you move to Hetzner?**
- First ISP letter, OR
- Sustained $50K+ MRR (= you can comfortably afford €5/mo for the
  upgrade), OR
- Your home internet upload starts to hurt (real users seeing slow
  page loads)

The Cloudflare cache headers shipped today raise the bar on #3
significantly — most public traffic won't hit your home pipe.

---

## 6. Quick verification checklist

Run this every time you make a change to your network setup
(new router, new ISP, moving rooms, etc.):

```bash
# Backend supervised by launchd?
launchctl list | grep com.txrappertracker.backend
# Expect: pid - com.txrappertracker.backend

# Backend answering?
curl -sS http://localhost:8787/health
# Expect: {"ok":true,"uptimeMs":...}

# Tunnel up?
curl -sS https://<your-cloudflare-domain>/api/health/deep | python3 -m json.tool
# Expect: status: ok

# Mac is configured to never sleep?
pmset -g | grep " sleep"
# Expect: sleep   0

# UPS reporting battery + connected?
pmset -g batt | head -3
# Expect: AC Power, Charge: 100%, ...
```

If all five lines look right, you're solid until something physically
fails. The launchd plist + UPS + sleep-disabled + deep-health monitor
covers everything short of "Mac dies."

---

## 7. When the Mac itself dies

Final escape hatch. The Mac is old (2009-2012 hardware). Eventually
something fails — PSU, drive, motherboard.

When that happens:
1. The Postgres data lives in `/usr/local/var/postgresql@16` —
   include it in your Time Machine backup or rsync it to an
   external drive weekly. Phase 2b shipped a script template for
   this; check `scripts/` for `backup-postgres.sh` if it exists,
   otherwise:
   ```bash
   pg_dump tx_rapper_tracker_dev | gzip > ~/backups/tx-$(date +%Y%m%d).sql.gz
   ```
2. The code lives in git, pushed to GitHub. No local-only state
   beyond Postgres + the .env file.
3. Recovery on a new machine: clone the repo, restore .env, restore
   Postgres dump, `npm run migrate`, `bash scripts/install-launchd-backend.sh`.
   ~30 minutes including download time.

If the Mac dies AND you need the site up immediately, the existing
Hetzner runbook (PHASE_3_5_HARDENING.md notes this is a 1-hour
provision) is your fastest path. Don't try to build a new home setup
under pressure.
