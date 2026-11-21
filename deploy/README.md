# FCMS dev server

The whole system on one machine (database, API, web app and HTTPS proxy), with
**demo data only**: the 90 simulated days in `db/sim/fcms_sim.dump`. No real
station's figures go in here.

## On any Ubuntu server, or your own machine

```bash
sudo apt install docker.io docker-compose-v2          # once
cd fcms-v2/deploy
cp .env.example .env
nano .env       # SITE_ADDRESS, PUBLIC_URL, and the four secrets (commands are in the file)
sudo docker compose up -d --build                     # first build: about 5 minutes
sudo docker compose logs -f db                        # wait for "demo ready: 180 shifts"
```

Open `PUBLIC_URL`. Sign in as `SUP01`, `MGR01`, `ACC01`, `HO01` or `SYSADMIN`
with `DEMO_PASSWORD`. Nobody is asked to change it: on a shared demo, the first
visitor would otherwise lock out everyone else.

To open it from anywhere, run it on a server with a public address and point a
domain at it. Caddy fetches the HTTPS certificate itself. Ports 80 and 443 must
be open: `sudo ufw allow 80,443/tcp`.

## Fresh dates

The demo's days end on the day the dump was made. To bring them up to
yesterday, make a new dump and start the database again from empty:

```bash
tools/sim/run.sh 90                                   # from fcms-v2/, about 3 minutes
cd deploy && sudo docker compose down -v && sudo docker compose up -d
```

`down -v` deletes the demo database volume, and with it anything visitors
entered. That is the point of a demo; it is never where real work goes.

## What is and is not exposed

* Only Caddy listens outside (80/443). The database and API are reachable only
  inside the compose network.
* Database errors show as a reference, not the detail
  (`Errors__ShowDatabaseDetail=false`).
* Swagger is not served through the proxy.
* The sign-in limit is per visitor: the API trusts Caddy's `X-Forwarded-For`,
  and only here, where nothing else can reach the API.
