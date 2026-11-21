const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const serverUrl = new URL(process.env.ORCHESTRATOR || 'http://127.0.0.1:9215');
const transport = serverUrl.protocol === 'https:' ? https : http;
const defaultPort = serverUrl.protocol === 'https:' ? 443 : 80;
const token = process.env.CLIENT_TOKEN || '';
const workerName = (process.env.WORKER_NAME || os.hostname() || 'worker')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 48) || 'worker';
const version = '1.1.0';
const maxConcurrent = Math.max(1, Math.min(32, Math.floor(Number(process.env.MAX_CONCURRENT) || 1)));
const workdir = __dirname;
const logLimit = 4000;
const resultLimit = 64;
const reconnectBaseMs = 3000;
const workerId = `${workerName}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
const allowLegacyShell = process.env.ALLOW_LEGACY_SHELL === '1';

const running = new Map();
const cancelled = new Set();
const pendingResults = [];

let resultDraining = false;
let resultRetry = null;
let shuttingDown = false;
let controlSocket = null;
let controlReq = null;
let controlAttempts = 0;
let reconnectTimer = null;
let signalReq = null;
let signalRetry = null;
let signalAttempts = 0;

function stamp() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function log(scope, message) {
    console.log(`[${stamp()}] ${scope.padEnd(7)} ${message}`);
}

function logError(scope, message) {
    console.error(`[${stamp()}] ${scope.padEnd(7)} ${message}`);
}

function short(id) {
    return String(id).slice(0, 8);
}

function authHeaders(extra = {}) {
    return token ? { 'x-worker-token': token, ...extra } : extra;
}

function baseOptions(method, pathname) {
    return {
        protocol: serverUrl.protocol,
        hostname: serverUrl.hostname,
        port: serverUrl.port || defaultPort,
        method,
        path: pathname,
    };
}

function createLineReader(onLine, onOverflow) {
    let buffer = '';

    return (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 64 * 1024) {
            buffer = '';
            onOverflow();
            return;
        }

        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                onLine(line);
            }
        }
    };
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

function postResult(result) {
    const payload = JSON.stringify({ workerId, ...result });

    return new Promise((resolve, reject) => {
        const req = transport.request(baseOptions('POST', '/api/worker/result'), (response) => {
            response.resume();
            response.on('end', () => {
                if (response.statusCode === 200) {
                    resolve();
                } else {
                    const error = new Error('result rejected (' + response.statusCode + ')');
                    error.statusCode = response.statusCode;
                    reject(error);
                }
            });
            response.on('error', reject);
        });

        req.setTimeout(10_000, () => req.destroy(new Error('result timeout')));
        req.on('error', reject);

        for (const [key, value] of Object.entries(authHeaders({
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        }))) {
            req.setHeader(key, value);
        }

        req.end(payload);
    });
}

function flushResultsToControl() {
    if (!controlSocket || controlSocket.destroyed) {
        return;
    }

    while (pendingResults.length > 0) {
        controlSocket.write(JSON.stringify({ type: 'result', ...pendingResults.shift() }) + '\n');
    }
}

async function drainResults() {
    if (resultDraining) {
        return;
    }
    if (controlSocket && !controlSocket.destroyed && controlSocket.writable) {
        flushResultsToControl();
        return;
    }
    if (pendingResults.length === 0) {
        return;
    }

    resultDraining = true;
    try {
        while (pendingResults.length > 0) {
            try {
                await postResult(pendingResults[0]);
                pendingResults.shift();
            } catch (error) {
                if (error.statusCode === 404) {
                    pendingResults.shift();
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        logError('result', 'post failed: ' + error.message);
        if (!shuttingDown && !resultRetry) {
            resultRetry = setTimeout(() => {
                resultRetry = null;
                drainResults().catch(() => {});
            }, reconnectBaseMs);
        }
    } finally {
        resultDraining = false;
    }
}

function sendResult(result) {
    if (controlSocket && !controlSocket.destroyed && controlSocket.writable) {
        try {
            controlSocket.write(JSON.stringify({ type: 'result', ...result }) + '\n');
            return;
        } catch {
            // fall through ke antrean
        }
    }

    pendingResults.push(result);
    while (pendingResults.length > resultLimit) {
        pendingResults.shift();
        logError('result', 'queue full, dropping oldest result');
    }
    drainResults().catch(() => {});
}

// ---------------------------------------------------------------------------
// control channel (Upgrade)
// ---------------------------------------------------------------------------

function scheduleReconnect() {
    if (shuttingDown || reconnectTimer) {
        return;
    }

    controlAttempts += 1;
    const delay = Math.min(30_000, reconnectBaseMs * Math.min(controlAttempts, 8))
        + Math.floor(Math.random() * 500);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectControl();
    }, delay);
}

function connectControl() {
    if (shuttingDown || controlReq) {
        return;
    }

    const req = transport.request({
        ...baseOptions('GET', '/api/worker'),
        headers: authHeaders({
            connection: 'Upgrade',
            upgrade: 'worker',
            'x-worker-id': workerId,
            'x-worker-name': workerName,
            'x-worker-version': version,
        }),
    });

    controlReq = req;
    const connectTimer = setTimeout(() => req.destroy(new Error('control connect timeout')), 20_000);
    connectTimer.unref();

    const clearConnectTimer = () => clearTimeout(connectTimer);

    req.on('upgrade', (response, socket) => {
        clearConnectTimer();
        controlReq = null;
        controlSocket = socket;
        controlAttempts = 0;

        log('control', `connected to ${serverUrl.origin} as ${workerId} (${maxConcurrent} slot)`);

        socket.setNoDelay(true);
        socket.setKeepAlive(true, 15_000);
        socket.write(JSON.stringify({
            type: 'hello',
            name: workerName,
            version,
            slots: maxConcurrent,
            running: [...running.keys()],
        }) + '\n');

        socket.on('data', createLineReader(handleLine, () => socket.destroy()));
        socket.on('error', (error) => logError('control', error.message));
        socket.on('close', () => {
            if (controlSocket === socket) {
                controlSocket = null;
                log('control', 'connection closed');
                // Job yang datang lewat control tidak bisa dilaporkan lagi;
                // hentikan supaya tidak jadi proses yatim di worker.
                for (const [id, entry] of running) {
                    if (entry.channel === 'control') {
                        entry.cancelled = true;
                        terminate(entry.child, id);
                    }
                }
                startSignal();
                scheduleReconnect();
            }
        });

        flushResultsToControl();
        drainResults().catch(() => {});
    });

    req.on('response', (response) => {
        clearConnectTimer();
        controlReq = null;
        response.resume();
        logError('control', `refused (${response.statusCode})`);
        startSignal();
        scheduleReconnect();
    });

    req.on('error', (error) => {
        clearConnectTimer();
        controlReq = null;
        logError('control', `offline: ${error.message}`);
        startSignal();
        scheduleReconnect();
    });

    req.end();
}

// ---------------------------------------------------------------------------
// signal fallback (server -> worker NDJSON over POST response)
// ---------------------------------------------------------------------------

function scheduleSignal() {
    if (shuttingDown || signalRetry) {
        return;
    }

    signalAttempts += 1;
    const delay = Math.min(30_000, reconnectBaseMs * Math.min(signalAttempts, 8))
        + Math.floor(Math.random() * 500);

    signalRetry = setTimeout(() => {
        signalRetry = null;
        startSignal();
    }, delay);
}

function startSignal() {
    if (shuttingDown || signalReq || controlSocket) {
        return;
    }

    const payload = JSON.stringify({
        id: workerId,
        name: workerName,
        version,
        slots: maxConcurrent,
        running: [...running.keys()],
    });

    const req = transport.request({
        ...baseOptions('POST', '/api/worker/signal'),
        headers: authHeaders({
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        }),
    });

    signalReq = req;
    const connectTimer = setTimeout(() => req.destroy(new Error('signal connect timeout')), 20_000);
    connectTimer.unref();

    req.on('response', (response) => {
        clearTimeout(connectTimer);

        if (response.statusCode !== 200) {
            response.resume();
            logError('signal', `rejected (${response.statusCode})`);
            if (signalReq === req) {
                signalReq = null;
            }
            scheduleSignal();
            return;
        }

        signalAttempts = 0;
        log('signal', 'fallback channel open');

        response.on('data', createLineReader(handleLine, () => response.destroy()));
        response.on('error', (error) => logError('signal', error.message));
        response.on('close', () => {
            if (signalReq === req) {
                signalReq = null;
                log('signal', 'closed');
                scheduleSignal();
            }
        });
    });

    req.on('error', (error) => {
        clearTimeout(connectTimer);
        if (signalReq === req) {
            signalReq = null;
        }
        logError('signal', `offline: ${error.message}`);
        scheduleSignal();
    });

    req.end(payload);
}

// ---------------------------------------------------------------------------
// job handling
// ---------------------------------------------------------------------------

function handleLine(line) {
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        logError('proto', 'malformed frame');
        return;
    }

    if (!message || typeof message !== 'object') {
        return;
    }

    if (message.type === 'job') {
        if (message.error) {
            logError('job', message.error);
        }
        if (message.job) {
            runJob(message.job);
        }
        return;
    }

    if (message.type === 'cancel') {
        cancelJob(message.id);
    }
}

function terminate(child, id) {
    if (process.platform === 'win32') {
        if (child.exitCode !== null) {
            return;
        }
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', (error) => logError('kill', error.message));
        killer.on('exit', (code) => {
            if (code !== 0) {
                logError('kill', `taskkill exit ${code} for ${short(id)}`);
            }
        });
        return;
    }

    const group = -child.pid;
    try {
        process.kill(group, 'SIGTERM');
    } catch {
        try {
            child.kill('SIGTERM');
        } catch {
            // sudah mati
        }
    }

    const timer = setTimeout(() => {
        if (!running.has(id)) {
            return;
        }
        logError('kill', `${short(id)} escalating to SIGKILL`);
        try {
            process.kill(group, 'SIGKILL');
        } catch {
            try {
                child.kill('SIGKILL');
            } catch {
                // sudah mati
            }
        }
    }, 3000);
    timer.unref();
}

function jobSpec(job) {
    if (Array.isArray(job.argv)) {
        if (
            job.argv.length === 0 ||
            job.argv.length > 64 ||
            !job.argv.every((entry) => typeof entry === 'string' && entry.length <= 4096)
        ) {
            return null;
        }

        if (job.argv[0] !== 'node' && job.argv[0] !== 'nodejs') {
            return null;
        }

        return { file: process.execPath, args: job.argv.slice(1), shell: false };
    }

    if (typeof job.command === 'string' && allowLegacyShell) {
        return { file: job.command, args: [], shell: true };
    }

    return null;
}

function runJob(job) {
    if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(job.id)) {
        logError('job', 'invalid job payload');
        return;
    }

    if (cancelled.delete(job.id)) {
        sendResult({ id: job.id, exitCode: 1, cancelled: true, output: 'cancelled before start' });
        return;
    }

    if (running.size >= maxConcurrent) {
        logError('job', `${short(job.id)} skipped: slots busy`);
        sendResult({ id: job.id, exitCode: 1, cancelled: false, output: 'skipped: slots busy' });
        return;
    }

    const spec = jobSpec(job);
    if (!spec) {
        logError('job', `${short(job.id)} rejected: unsupported command payload`);
        sendResult({ id: job.id, exitCode: 1, cancelled: false, output: 'rejected: unsupported command payload' });
        return;
    }

    const startedAt = Date.now();
    const child = spawn(spec.file, spec.args, {
        cwd: workdir,
        shell: spec.shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry = {
        child,
        cancelled: false,
        done: false,
        startedAt,
        timer: null,
        channel: job.channel === 'signal' ? 'signal' : 'control',
    };
    running.set(job.id, entry);

    let output = '';
    const collect = (chunk) => {
        output = (output + chunk.toString('utf8')).slice(-logLimit);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const duration = Number(job.time) > 0 ? Number(job.time) : 300;
    entry.timer = setTimeout(() => {
        if (entry.done) {
            return;
        }
        entry.cancelled = true;
        logError('job', `${short(job.id)} duration exceeded, terminating`);
        terminate(child, job.id);
    }, duration * 1000 + 8000);
    entry.timer.unref();

    log('job', `${short(job.id)} start  ${job.name || '?'} ${job.target || '?'} ${job.time || '?'}s`);

    const finish = (exitCode, note) => {
        if (entry.done) {
            return;
        }
        entry.done = true;
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        running.delete(job.id);

        const text = note ? `${output}\n${note}`.slice(-logLimit) : output;
        log(
            entry.cancelled ? 'stop' : 'job',
            `${short(job.id)} ${entry.cancelled ? 'cancelled' : 'exit=' + exitCode}  ${Date.now() - startedAt}ms`,
        );
        sendResult({
            id: job.id,
            exitCode,
            cancelled: entry.cancelled,
            output: text,
        });
    };

    child.on('error', (error) => finish(1, `Spawn failed: ${error.message}`));
    child.on('close', (code) => finish(Number.isInteger(code) ? code : 1));
}

function cancelJob(id) {
    if (typeof id !== 'string') {
        return;
    }

    const entry = running.get(id);
    if (!entry) {
        if (cancelled.size >= 1000) {
            cancelled.clear();
        }
        cancelled.add(id);
        sendResult({ id, exitCode: 1, cancelled: true, output: 'not running' });
        log('stop', `${short(id)} cancel ignored (not running)`);
        return;
    }

    entry.cancelled = true;
    log('stop', `${short(id)} stop requested`);
    terminate(entry.child, id);
}

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
    if (shuttingDown) {
        process.exit(130);
    }

    shuttingDown = true;
    log('worker', `shutting down (${signal})`);

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (signalRetry) {
        clearTimeout(signalRetry);
        signalRetry = null;
    }
    if (resultRetry) {
        clearTimeout(resultRetry);
        resultRetry = null;
    }
    if (controlReq) {
        controlReq.destroy();
        controlReq = null;
    }

    for (const [id, entry] of running) {
        entry.cancelled = true;
        terminate(entry.child, id);
    }

    if (controlSocket) {
        controlSocket.end();
    }
    if (signalReq) {
        signalReq.destroy();
    }

    setTimeout(() => process.exit(0), 1500).unref();
}

for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
        if (error && error.code === 'EPIPE') {
            process.exit(0);
        }
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
    logError('process', error && error.stack ? error.stack : String(error));
    shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
    logError('process', error && error.stack ? error.stack : String(error));
});

log('worker', `${workerId} -> ${serverUrl.origin}  (${maxConcurrent} slot, ${workdir})`);
connectControl();