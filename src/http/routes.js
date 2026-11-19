const { sendJson, readJsonBody, single, duplicated } = require('./respond');
const { renderDocs } = require('./docs');
const {
    apiTokenMatches,
    isValidTarget,
    normalizeTarget,
    displayTarget,
    isValidDuration,
    isValidMethod,
} = require('../core/validation');
const { buildJob, methodNames, methodSummary } = require('../core/methods');

function createRoutes(ctx) {
    function authorized(request) {
        return apiTokenMatches(ctx.config.apiToken, request);
    }

    function fromQuery(searchParams) {
        for (const name of ['host', 'time', 'itme', 'method']) {
            if (duplicated(searchParams, name)) {
                return { error: `Duplicate query parameter: ${name}` };
            }
        }

        return {
            host: single(searchParams, 'host'),
            time: single(searchParams, 'time') ?? single(searchParams, 'itme'),
            method: single(searchParams, 'method'),
        };
    }

    async function fromBody(request) {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return { error: 'Body must be a JSON object' };
        }

        return {
            host: body.host,
            time: body.time !== undefined
                ? String(body.time)
                : body.itme !== undefined ? String(body.itme) : undefined,
            method: body.method,
        };
    }

    async function handleAttack(request, response) {
        if (request.method !== 'GET' && request.method !== 'POST') {
            sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET, POST' });
            return;
        }
        if (!authorized(request)) {
            sendJson(response, 401, { error: 'Unauthorized' });
            return;
        }

        let params;
        try {
            params = request.method === 'POST'
                ? await fromBody(request)
                : fromQuery(new URL(request.url, 'http://localhost').searchParams);
        } catch (error) {
            sendJson(response, error.statusCode || 400, { error: error.message });
            return;
        }

        if (params.error) {
            sendJson(response, 400, { error: params.error });
            return;
        }

        const { host, time, method } = params;
        if (!host || time === undefined || !method) {
            sendJson(response, 400, { error: 'host, time and method are required' });
            return;
        }
        if (!isValidTarget(host)) {
            sendJson(response, 400, { error: 'host must be a valid http(s) URL without whitespace' });
            return;
        }
        if (!isValidDuration(time, ctx.config.maxAttackTime)) {
            sendJson(response, 400, { error: `time must be an integer between 1 and ${ctx.config.maxAttackTime}` });
            return;
        }
        if (!isValidMethod(ctx.methods, method)) {
            sendJson(response, 400, { error: `Unknown method, available: ${methodSummary(ctx.methods)}` });
            return;
        }

        if (!ctx.scheduler.canAccept()) {
            sendJson(response, 503, { error: 'Queue is full, try again later' }, { 'retry-after': '10' });
            return;
        }

        const target = normalizeTarget(host);
        const built = buildJob(ctx.methods, method, target, Number(time));
        if (!built) {
            sendJson(response, 400, { error: 'Method template is unavailable' });
            return;
        }

        const job = ctx.jobs.submit({
            name: method,
            target,
            time: Number(time),
            argv: built.argv,
        });

        ctx.scheduler.dispatch();

        const assigned = job.workerId !== null;
        sendJson(response, 202, {
            id: job.id,
            status: assigned ? 'dispatched' : 'queued',
            worker: job.workerId,
            method: job.name,
            host: job.target,
            time: job.time,
            statusUrl: `/api/attack/${job.id}`,
        });
        ctx.logger.info('http', `attack accepted  ${method} ${displayTarget(target)} ${time}s`);
    }

    function handleJobStatus(response, id) {
        const job = ctx.jobs.get(id);
        if (!job) {
            sendJson(response, 404, { error: 'Job not found' });
            return;
        }

        sendJson(response, 200, {
            id: job.id,
            status: ctx.jobs.statusOf(job),
            cancelling: job.cancelling,
            method: job.name,
            host: job.target,
            time: job.time,
            itme: job.time,
            workerId: job.workerId,
            worker: job.workerId,
            queuedAt: job.queuedAt,
        });
    }

    function handleStop(response, id) {
        const job = ctx.jobs.get(id);
        if (!job) {
            sendJson(response, 404, { error: 'Job not found or already finished' });
            return;
        }

        const outcome = ctx.jobs.cancel(job);
        sendJson(response, 202, {
            id: job.id,
            status: outcome === 'stopping' ? 'stopping' : 'cancelled',
            outcome,
        });
    }

    function handleWorkers(response) {
        sendJson(response, 200, {
            workers: ctx.workers.list().map(ctx.workers.publicWorker),
            waiting: ctx.workers.waiterCount(),
            queued: ctx.state.pending.length,
            active: ctx.state.jobs.size,
        });
    }

    function handleHealth(response) {
        sendJson(response, 200, {
            uptime: Math.floor(process.uptime()),
            workers: ctx.workers.list().length,
            waiting: ctx.workers.waiterCount(),
            queued: ctx.state.pending.length,
            active: ctx.state.jobs.size,
            methods: methodNames(ctx.methods),
        });
    }

    function handleDocs(request, response) {
        const page = renderDocs({ request, config: ctx.config, methods: ctx.methods });
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(page),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        });
        response.end(page);
    }

    function route(request, response) {
        const url = new URL(request.url, 'http://localhost');
        const { pathname } = url;

        if (pathname === '/api/health') {
            if (request.method !== 'GET') {
                sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
                return;
            }
            handleHealth(response);
            return;
        }

        if (pathname === '/api/attack') {
            return handleAttack(request, response);
        }

        if (pathname.startsWith('/api/attack/')) {
            if (request.method !== 'GET') {
                sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
                return;
            }
            if (!authorized(request)) {
                sendJson(response, 401, { error: 'Unauthorized' });
                return;
            }
            handleJobStatus(response, pathname.slice('/api/attack/'.length));
            return;
        }

        if (pathname.startsWith('/api/stop/')) {
            if (request.method !== 'POST') {
                sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
                return;
            }
            if (!authorized(request)) {
                sendJson(response, 401, { error: 'Unauthorized' });
                return;
            }
            handleStop(response, pathname.slice('/api/stop/'.length));
            return;
        }

        if (pathname === '/api/workers') {
            if (request.method !== 'GET') {
                sendJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
                return;
            }
            if (!authorized(request)) {
                sendJson(response, 401, { error: 'Unauthorized' });
                return;
            }
            handleWorkers(response);
            return;
        }

        if (pathname === '/api/worker/signal') {
            return ctx.workerSignal.handle(request, response);
        }

        if (pathname === '/api/worker/result') {
            return ctx.workerSignal.handleResult(request, response);
        }

        if (request.method === 'GET' && pathname === '/') {
            handleDocs(request, response);
            return;
        }

        sendJson(response, 404, { error: 'Not found' });
    }

    return { route };
}

module.exports = { createRoutes };