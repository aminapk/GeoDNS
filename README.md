# GeoDNS Admin (CoreDNS GeoDNS Control Panel)

Production-focused first version of a CoreDNS GeoDNS management panel.

It provides:
- CoreDNS installation and service setup
- GeoDNS web dashboard (Node.js + React + SQLite)
- First-run setup flow (admin account + default nameservers)
- Domain/view/record management
- Apply workflow with validation + dry-run + backups
- Rollback to latest backup snapshot

---

## Architecture

- **DNS engine:** CoreDNS (`coredns.service`)
- **Admin backend/UI:** Node.js Express + React static frontend (`geodns-admin.service`)
- **Draft/config database:** SQLite (`/var/lib/geodns-admin/admin.db`)
- **Reverse proxy + TLS:** Caddy (`caddy.service`, optional if domain provided)

---

## Repository Layout

- `install.sh` - one-command installer for server setup
- `admin/server.js` - backend API + auth/session + setup flow
- `admin/coredns.js` - CoreDNS render/apply/dry-run/backup/rollback logic
- `admin/db.js` - SQLite schema and storage
- `admin/public/` - React UI (single-page admin dashboard)
- `admin/package.json` - backend dependencies

---

## Requirements

- Ubuntu/Debian-like Linux server
- Root access (`sudo` / root shell)
- Open ports:
  - `53/tcp` + `53/udp` for DNS
  - `80/tcp` + `443/tcp` if using dashboard domain + HTTPS
  - `3000/tcp` only if running dashboard by IP without reverse proxy

---

## First-Time Installation

Run from this repository root:

```bash
bash /root/GeoDNS/install.sh
```

Installer prompts:
- dashboard domain (optional; if provided, Caddy TLS is configured)
- default nameserver 1
- default nameserver 2

What installer does:
- installs dependencies
- installs CoreDNS binary
- creates base CoreDNS config (`.:53` only)
- deploys admin app to `/opt/geodns-admin`
- creates systemd units for CoreDNS and dashboard
- configures Caddy if domain is provided

---

## Initial Setup (Web)

After install, open:
- `https://<dashboard-domain>` (if provided), or
- `http://<server-ip>:3000` (if no domain)

On first launch, complete setup:
- admin username/password
- default nameservers

---

## Daily Operations

- **Add/Update domains:** in dashboard
- **Apply Changes:** validates draft and applies to CoreDNS
- **Rollback Last Apply:** restores latest backup snapshot
- **Sync from CoreDNS:** imports domain/view definitions from active Corefile/zone files

---

## Validation and Safety

Before apply, system performs:
- domain/view/record validation
- dry-run CoreDNS config test
- optional zone check (if `named-checkzone` exists)

On successful apply:
- backup snapshot is created in `/var/lib/geodns-admin/backups`
- CoreDNS is reloaded with generated Corefile and zones

---

## Service Commands

```bash
systemctl status geodns-admin
systemctl status coredns
systemctl status caddy

journalctl -u geodns-admin -f
journalctl -u coredns -f
journalctl -u caddy -f
```

---

## Upgrade Procedure

1. Pull/update repository code.
2. Copy updated app files to runtime path:
   - `/opt/geodns-admin/*`
3. Restart service:
   - `systemctl restart geodns-admin`
4. Validate:
   - open dashboard, test apply, verify DNS responses

Tip: always keep a backup snapshot before large changes.

---

## Troubleshooting

- **Not authenticated**
  - re-login on exact dashboard hostname
  - check Caddy domain matches URL host

- **Apply fails with bind address already in use**
  - fixed in this version by dry-run port remap (`:53` -> `:1053`) in temp validation

- **named-checkzone ENOENT**
  - installer includes `bind9-utils`
  - runtime gracefully skips zone check if binary is missing

- **Panel not loading**
  - verify `geodns-admin.service` and `caddy.service` status
  - check `/etc/caddy/Caddyfile` domain correctness

---

## Security Notes

- Use strong admin password
- Prefer HTTPS dashboard domain
- Restrict dashboard exposure with firewall/security groups
- Keep server packages updated

---

## License

No license file has been finalized yet. Add your preferred OSS/commercial license before public release.
