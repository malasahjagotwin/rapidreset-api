const { readJsonBody, sendJson } = require('../http/respond');
const { isValidWorkerId, tokenMatches } = require('../core/validation');

function createWorkerSignal(ctx) {
    const { state } = ctx;

    function handle(request, response) {
        if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
            return;
        }
        if (!tokenMatches(ctx.config.clientToken, request.headers['x-worker-token'])) {
            sendJson(response, 401, { error: 'Unauthorized' });
            return;
        }

        readJsonBody(request)
            .then((body) => {
                const id = body.id;
                if (!isValidWorkerId(id)) {
                    sendJson(response, 400, { error: 'id is required' });
                    return;
                }

                const previous = state.waiters.get(id);
                const jobs = previous ? previous.jobs : new Set();
                if (previous) {
                    ctx.workers.removeWaiter(previous);
                    previous.close();
                }

                const slots = Number(body.slots);
                const waiter = {
                    id,
                    name: typeof body.name === 'string' ? body.name.slice(0, 64) : 'unknown',
                    version: typeof body.version === 'string' ? body.version.slice(0, 32) : 'unknown',
                    slots: Number.isInteger(slots) && slots >= 1 && slots <= 32 ? slots : 1,
                    jobs,
                    response,
                    send(message) {
                        if (!response.destroyed) {
                            response.write(JSON.stringify(message) + '\n');
                        }
                    },
                    close() {
                        if (!response.destroyed) {
                            response.end();
                        }
                    },
                };

                ctx.workers.registerWaiter(waiter);

                response.writeHead(200, {
                    'content-type': 'application/x-ndjson; charset=utf-8',
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                });
                // Header harus dikirim sekarang; tanpa ini worker tidak pernah
                // menerima event 'response' saat belum ada job.
                response.flushHeaders();

                response.on('error', () => {});
                response.on('close', () => {
                    ctx.workers.removeWaiter(waiter);
                });

                ctx.logger.debug('worker', `${id} signal channel open · ${waiter.slots} slot(s)`);
                ctx.scheduler.dispatch();
            })
            .catch((error) => {
                sendJson(response, error.statusCode || 400, { error: error.message });
            });
    }

    function handleResult(request, response) {
        if (request.method !== 'POST') {
            sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
            return;
        }
        if (!tokenMatches(ctx.config.clientToken, request.headers['x-worker-token'])) {
            sendJson(response, 401, { error: 'Unauthorized' });
            return;
        }

        readJsonBody(request)
            .then((body) => {
                const workerId = body.workerId;
                const id = body.id;

                if (!isValidWorkerId(workerId) || typeof id !== 'string') {
                    sendJson(response, 400, { error: 'workerId and id are required' });
                    return;
                }

                const job = state.jobs.get(id);
                if (!job || job.workerId !== workerId) {
                    sendJson(response, 404, { error: 'Job not found' });
                    return;
                }

                ctx.jobs.finish(
                    job,
                    Number.isInteger(body.exitCode) ? body.exitCode : 1,
                    body.output,
                    Boolean(body.cancelled),
                );
                sendJson(response, 200, { accepted: true });
            })
            .catch((error) => {
                sendJson(response, error.statusCode || 400, { error: error.message });
            });
    }

    return { handle, handleResult };
}

module.exports = { createWorkerSignal };