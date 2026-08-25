# gatewaittimes-collectors

Data collectors for [gatewaittimes.com](https://gatewaittimes.com) — live US airport
security wait times. Polls TSA wait data, FAA NAS status, NWS weather, and CBP
customs waits on a schedule and writes normalized readings to Postgres.

This is a deploy mirror; the source of truth lives in a private monorepo.
Secrets (API keys, database) are injected via GitHub Actions secrets — nothing
sensitive lives in this repo.
