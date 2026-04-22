# GeoDNS Admin

Simple Node.js + React web interface for managing CoreDNS GeoDNS domains, views, and records.

## Features

- Single admin login (session cookie)
- SQLite draft storage
- One-page domain/view/record editor
- `Save Draft` and `Apply Changes` workflow
- `Apply Changes` rewrites CoreDNS zone files and restarts CoreDNS

## Notes

- This service is designed to run on the same server as CoreDNS.
- It needs permissions to write under `/etc/coredns` and restart the `coredns` systemd service.
