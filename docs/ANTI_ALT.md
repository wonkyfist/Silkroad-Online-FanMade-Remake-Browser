# Registration & anti-alt

Limits on new accounts and characters, VPN / proxy / hosting detection, and tools for GMs to spot alts. Code:
`apps/server/src/antialt/`, admin page `apps/admin/src/pages/antialt.ts`, client signals `apps/game/src/net/device.ts`.

## 1. Overview

Every check runs on the server. Requests from this machine (127.0.0.1, ::1) skip every limit by default (bots, benches,
tests). Allowlisted IPs, subnets and devices skip every limit and detection. GMs and admins are never limited on
characters and never blocked at login.

## 2. Limits (admin panel: Registration & anti-alt)

Every limit is on/off, a count and a sliding window in minutes, hours, days or weeks ("3 per 1 days").

- Accounts per IP (default 10 per 1 hour: the old "Registrations per IP per hour", whose saved value moves here once).
- Accounts per subnet: IPv4 /24, IPv6 /64 (default 20 per 1 day).
- Accounts per device (default 3 per 1 day) and a lifetime cap per device (default 10).
- §2.3 Characters per account (default 4 per 1 day), per device (8 per 1 day), per IP (12 per 1 day); deleted characters
  still count by default, so delete-and-recreate does not dodge the limit.

Successful registrations and creations count. A registration reserves its slot before the password hash, so parallel
requests cannot share one free slot. Players see the wait: "Too many accounts from this network, try again in 2 days."

## 3. Addresses

§3.2 The client address is the socket's, unless `TRUST_PROXY=true` and the socket's peer is in `TRUSTED_PROXIES`
(default `127.0.0.1/32, ::1/128`: Caddy on the same host). Then `X-Forwarded-For` is read from the right, past every
trusted proxy; the first other address is the client. A header sent by anyone else is ignored. Behind Cloudflare: add
Cloudflare's ranges to `TRUSTED_PROXIES` (or keep your reverse proxy resolving them) and optionally set
`CLIENT_IP_HEADER=cf-connecting-ip`.

## 4. VPN, proxy and hosting detection

Bundled offline lists in `content/antialt/`, refreshed with `pnpm antialt:update`:

- `hosting-ranges.txt`: client9/ipcat datacenters.csv (MIT licence) plus the ranges AWS, Google Cloud, Oracle Cloud,
  DigitalOcean and Linode publish for public use.
- `tor-exits.txt`: the Tor Project's bulk exit list.

Each check (hosting, Tor, external lookup) has a mode: off / flag only / block registration / block registration and
character creation / block registration, characters and login. Defaults: flag only.

§4.3 External lookup: off until the server environment has `ANTIALT_LOOKUP=proxycheck` and `PROXYCHECK_KEY=<key>`
(proxycheck.io). Answers are cached 6 hours; a failing provider counts as "not a proxy".

## 5. Device ID and fingerprint

The client makes a random device ID once and keeps it in localStorage, IndexedDB and a first-party cookie (whichever
survives restores the others), and sends it with register and login, together with a SHA-256 of a light fingerprint
(user agent, screen, time zone, languages, WebGL renderer, core count). The fingerprint is a soft signal: many machines
share one, so it never blocks on its own. With "Fingerprint + subnet counts as the same device" on, an account from the
same fingerprint and the same subnet counts toward the device limits. It always shows under Linked accounts (marked weak).

## 6. Robot check

Cloudflare Turnstile on register: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in the server environment, then
turn it on in the panel. Without both keys the switch does nothing.

## 7. Privacy

Privacy: device IDs and fingerprints are stored only as HMAC-SHA256 hashes under a random per-server salt; the
blocked/flagged log and login records are deleted after the configured days (default 30); registration and
character-creation records (IP, subnet, hashes) are kept so the limits and Linked accounts work.

Tables (admin migration 2 in `apps/server/src/admin/store.ts`): `antialt_meta`, `antialt_events`, `antialt_log`,
`antialt_allow`.

## 8. Admin panel

Players & Accounts → Registration & anti-alt: every setting, the log of blocked and flagged attempts (time, action,
reason, account, IP, subnet, device) with Lift (the events that filled the limit stop counting; a detection block puts
the IP on the allowlist), and the allowlist. Each account page shows Linked accounts: other accounts sharing a device,
IP, subnet or fingerprint.
