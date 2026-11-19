const { createLineReader } = require('./ndjson');
const { isValidWorkerId, tokenMatches } = require('../core/validation');

function createWorkerSocket(ctx) {
    const { state } = ctx;

    function reject(socket, status, reason, request) {
        const id = request.headers['x-worker-id'] || socket.remoteAddress || 'unknown';
        ctx.logger.warn('worker', `${id} rejected: ${reason}`);
        socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    }

    function handleMessage(worker, message) {
        if (!message || typeof message !== 'object') {
            return;
        }

        if (message.type === 'hello') {
            if (typeof message.name === 'string' && message.name.trim()) {
                worker.name = message.name.slice(0, 64);
            }
            if (typeof message.version === 'string') {
                worker.version = message.version.slice(0, 32);
            }
            const slots = Number(message.slots);
            if (Number.isInteger(slots) && slots >= 1 && slots <= 32) {
                worker.slots = slots;
            }
            if (!worker.ready) {
                worker.ready = true;
                ctx.logger.ok(
                    'worker',
                    `${worker.id} ready  ${worker.name} ${worker.version} · ${worker.slots} slot(s)`,
                );
            }
            ctx.scheduler.dispatch();
            return;
        }

        if (message.type === 'result') {
            const job = state.jobs.get(message.id);
            if (!job || job.workerId !== worker.id) {
                return;
            }
            ctx.jobs.finish(
                job,
                Number.isInteger(message.exitCode) ? message.exitCode : 1,
                message.output,
                Boolean(message.cancelled),
            );
        }
    }

    function handle(socket, request) {
        const id = request.headers['x-worker-id'];

        if (!isValidWorkerId(id)) {
            reject(socket, '400 Bad Request', 'invalid worker id', request);
            return;
        }
        if (!tokenMatches(ctx.config.clientToken, request.headers['x-worker-token'])) {
            reject(socket, '401 Unauthorized', 'bad worker token', request);
            return;
        }
        if (request.headers['sec-websocket-key']) {
            reject(socket, '400 Bad Request', 'unexpected websocket key', request);
            return;
        }

        const existing = state.workers.get(id);
        if (existing && existing.socket !== socket) {
            ctx.workers.removeSocket(existing, 'Worker reconnected');
        }

        const worker = {
            id,
            name: typeof request.headers['x-worker-name'] === 'string'
                ? request.headers['x-worker-name'].slice(0, 64)
                : 'unknown',
            version: typeof request.headers['x-worker-version'] === 'string'
                ? request.headers['x-worker-version'].slice(0, 32)
                : 'unknown',
            connectedAt: Date.now(),
            slots: 1,
            jobs: new Set(),
            socket,
            send(message) {
                if (!socket.destroyed) {
                    socket.write(JSON.stringify(message) + '\n');
                }
            },
        };

        ctx.workers.registerSocket(worker);

        socket.setNoDelay(true);
        socket.setKeepAlive(true, 15_000);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: worker\r\nconnection: upgrade\r\n\r\n');

        const read = createLineReader(
            (line) => {
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }
                handleMessage(worker, message);
            },
            { onOverflow: () => socket.destroy() },
        );

        socket.on('data', read);
        socket.on('error', () => {});
        socket.on('end', () => socket.destroy());
        socket.on('close', () => {
            ctx.workers.removeSocket(worker, 'Worker disconnected before finishing the job');
        });

        ctx.logger.debug('worker', `${id} transport connected`);
        ctx.scheduler.dispatch();
    }

    return { handle };
}

module.exports = { createWorkerSocket };