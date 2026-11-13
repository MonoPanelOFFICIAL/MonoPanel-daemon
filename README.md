# MonoPanel daemon (v4.1)

One agent per node. It runs customer **servers** (bots, Node.js apps, websites, Lavalink) and customer **VPSes** for the MonoPanel panel, on one port with one secret. **No npm runtime dependencies**, hardened, and it works on any kind of machine.

| Feature | Hosting type | Needs | Routes |
|---|---|---|---|
| Servers | Bot, Node.js, Lavalink, Website | nothing (Docker, Podman or the native sandbox) | `/v1/servers/*` |
| Lavalink tools | Lavalink | a Lavalink software image | `/v1/servers/:id/lavalink/*` |
| Node.js tools | Node.js, Website, Bot | a Node.js software image | `/v1/servers/:id/nodejs/*` |
| Website proxy | Website | ports 80/443 (optional TLS certs) | built in, see *Website hosting* |
| VPSes | VPS | Docker CLI | `/v1/vps/*` |

**One daemon runs every hosting type.** Which types a node accepts is set with `NODE_SERVICES` (`bot,nodejs,website,lavalink,vps`; empty = all). Which types you *sell* is chosen in the panel under Admin → Hosting Types. A node without Docker still runs servers; VPS routes answer `501` until Docker is installed.

## Requirements
Node.js 20+, **a PostgreSQL 12+ database** for the daemon's state (see *Local state*) and (optional) one of: Docker, Podman, or `bubblewrap` for the native sandbox. **VPS hosting needs Docker** (the `docker` CLI). `tar` (and `unzip` for zip extraction) must be installed for backups/extract.

## Install
There is no installer yet. In the panel add the node under **Admin → Nodes** (servers) and/or **Admin → VPS Nodes** (VPSes), copy the daemon folder to the machine, and run the command the panel shows, e.g.

```sh
cd daemon && npm install && npm run build && npm run configure -- --panel https://panel.example.com --key <secret> --port 3002 --allow <panel-ip> --database postgres://daemon:<password>@127.0.0.1:5432/monopanel_daemon && npm start
```

**Updating:** pull/copy the new daemon files and run the same command again. `configure` keeps your existing `.env` values and only changes what you pass; database changes are additive and applied on start, so running servers are not touched. Add `--services nodejs,lavalink` (any of `bot,nodejs,website,lavalink,vps`) to limit what a node accepts. For website hosting also pass `--web-http 80 --web-https 443 [--cert-dir /etc/letsencrypt/live]`.

If you register the same address in both places the panel uses one shared secret, so you only configure the daemon once. `configure` writes `.env` with mode 600 (add `--vps docker|auto|mock|off` to set `VPS_RUNTIME`, `--database <postgres url>` to set `DATABASE_URL`). Keep the secret private; rotate it from the panel at any time.
Run it as a dedicated unprivileged user (add that user to the `docker` group for Docker). A systemd unit:

```ini
[Service]
User=monopanel
WorkingDirectory=/opt/monopanel/daemon
ExecStart=/usr/bin/node dist/index.js
Restart=always
NoNewPrivileges=true
```

## Runtimes
`RUNTIME=auto` (default) tries the Docker socket, then Podman, then the native sandbox.

| Setting | Meaning |
|---|---|
| `CONTAINER_SOCKET` | `/var/run/docker.sock`, `/run/podman/podman.sock`, `//./pipe/docker_engine` (Windows) |
| `OCI_RUNTIME=runsc` | gVisor (also `kata`, `sysbox-runc`) for stronger isolation |
| `RUNTIME=process` | no container engine (OpenVZ/LXC/Termux/tiny VPS). Install `bubblewrap` for namespace + read-only-root isolation |

## Security model
* Every request is HMAC-signed (timestamp + single-use nonce + hash of the exact body). No signature, no answer.
* Set `ALLOWED_IPS` to the panel's IP and use `TLS_CERT`/`TLS_KEY` (or a private network) when crossing the internet.
* Server ids are validated; file paths are confined to the server volume (symlinks refused); downloads block private addresses.
* Containers drop all capabilities, forbid privilege escalation, and are limited in RAM, swap, CPU and processes. Disk quota is enforced by the daemon.

## SFTP (optional)
Set `SFTP_PORT` (or `--sftp 2022` with `configure`) and run `npm install` (installs the optional `ssh2` package). Users log in as `<panel-username>.<server-id8>` with the password they create in the panel. A login only ever sees one server's files; symlinks are not followed, writes respect the disk quota, and shell/exec are refused. Without `ssh2` the daemon logs a warning and runs without SFTP.

## Website hosting
Website servers get a built-in reverse proxy: requests are routed by `Host` header to the right site (websockets included). Enable it with `WEB_HTTP_PORT=80` and optionally `WEB_HTTPS_PORT=443` (the daemon needs permission to bind those ports, e.g. `setcap 'cap_net_bind_service=+ep' $(which node)`).

| Setting | Meaning |
|---|---|
| `WEB_HTTP_PORT` / `WEB_HTTPS_PORT` | `0` = off. Typical: 80 and 443 |
| `WEB_CERT_DIR` | certbot-layout directory (`<domain>/fullchain.pem` + `privkey.pem`); certificates are picked by SNI |
| `WEB_ACME_DIR` | webroot for `certbot certonly --webroot -w <dir> -d example.com` |
| `WEB_FORCE_HTTPS` | redirect HTTP to HTTPS for domains that have a certificate |
| `WEB_TRUST_PROXY` | IP(s) of a proxy / CDN in front of the daemon, so `X-Forwarded-For` is believed |

Custom domains are verified by the panel (TXT record or CNAME to the site's free subdomain) and pushed to the daemon, which only serves domains it was told about.

## Node switching and addons
The panel can move a server between nodes (streamed, checksum-verified, rolled back on failure) and install addon files. Both use signed daemon routes; addon downloads are SSRF-guarded (set `ALLOW_PRIVATE_DOWNLOADS=true` only for testing). `MAX_TRANSFER_MB` caps the compressed size a node will accept.

## VPS hosting
Every VPS is one Docker container built from the ROM in `rom/` (Ubuntu/Debian + sshd, Docker, Node.js, pm2, build tools). The first create builds the image, which takes a few minutes; set `VPS_PREBUILD_OS=ubuntu-22.04` to build it at daemon start instead.

| Setting | Meaning |
|---|---|
| `VPS_RUNTIME` | `auto` (default: on when Docker answers), `docker` (required), `mock` (dev only), `off` |
| `VPS_OCI_RUNTIME=sysbox-runc` | lets customers run Docker inside their VPS safely (recommended) |
| `VPS_PRIVILEGED=true` | alternative to sysbox. **Insecure**: a VPS root user can escape to the host |
| `VPS_ALLOWED_BASE_PREFIXES` | base images the panel may request (default `ubuntu:,debian:`) |

Keep the panel's VPS SSH port range (default 42000-42999) outside `PORT_MIN`-`PORT_MAX`.
Container names (`monovps-<id>`) and the `monovps=1` label are kept from the old VPS daemon so existing VPSes keep working.

## Local state
The daemon stores everything it needs to remember in **PostgreSQL** (`DATABASE_URL`): the server definitions, the installer progress and the recycle-bin index. There is no SQLite file and no JSON state file. Tables (`daemon_servers`, `daemon_installs`, `daemon_recycle`, `daemon_meta`) are created on first start.

- Create a database and user first: `CREATE USER daemon WITH PASSWORD '...'; CREATE DATABASE monopanel_daemon OWNER daemon;`
- Use **one database (or one `DATABASE_TABLE_PREFIX`) per node**. A second daemon on the same database is refused on purpose.
- The daemon keeps a copy in memory so reads are instant; every write goes to PostgreSQL first. If PostgreSQL is down the daemon refuses to start, and changes that need the database fail instead of being half-applied.
- Back it up with `pg_dump`, point-in-time recovery or your provider's snapshots. Server files themselves live under `DATA_DIR` and are not in the database.
- Behind PgBouncer use session pooling (transaction pooling cannot hold the single-daemon lock).

## Build
```sh
npm install && npm run build   # TypeScript -> dist/
```
