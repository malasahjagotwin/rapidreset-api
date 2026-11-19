const os = require('node:os');
const pkg = require('../package.json');
const { loadConfig } = require('./core/config');
const { createState } = require('./core/state');
const { loadMethods, methodSummary } = require('./core/methods');
const { createLogger } = require('./ui/console');
const { createWorkers } = require('./broker/workers');
const { createScheduler } = require('./broker/scheduler');
const { createJobs } = require('./broker/jobs');
const { createWorkerSocket } = require('./broker/worker-socket');
const { createWorkerSignal } = require('./broker/worker-signal');
const { createRoutes } = require('./http/routes');
const { createServer, shutdown } = require('./http/server');

function localAddress(host, port) {
    if (host !== '0.0.0.0' && host !== '::' && host !== '') {
        return `http://${host}:${port}`;
    }

    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                return `http://${entry.address}:${port}`;
            }
        }
    }

    return null;
}

function createApp({ env = process.env } = {}) {
    const config = loadConfig(env);
    const logger = createLogger({ env });
    const methods = loadMethods(config.methodsFile, logger);
    const state = createState();

    const ctx = { config, logger, methods, state };
    ctx.workers = createWorkers(ctx);
    ctx.scheduler = createScheduler(ctx);
    ctx.jobs = createJobs(ctx);
    ctx.workerSocket = createWorkerSocket(ctx);
    ctx.workerSignal = createWorkerSignal(ctx);
    ctx.routes = createRoutes(ctx);
    ctx.server = createServer(ctx);

    const version = pkg.version;

    function start() {
        return new Promise((resolve, reject) => {
            const onError = (error) => {
                reject(error);
            };

            ctx.server.once('error', onError);
            ctx.server.listen(config.port, config.host, () => {
                ctx.server.off('error', onError);

                const tokenState = [
                    config.clientToken ? 'worker' : null,
                    config.apiToken ? 'api' : null,
                ].filter(Boolean).join(' + ') || 'off';

                const listen = `${config.host}:${config.port}`;
                const local = localAddress(config.host, config.port);

                logger.banner({
                    version,
                    node: process.version,
                    listen,
                    local: local === `http://${listen}` ? null : local,
                    methods: methodSummary(methods),
                    token: tokenState,
                });

                if (!config.clientToken) {
                    logger.warn('config', 'CLIENT_TOKEN is off; any client can connect as a worker');
                }
                if (!config.apiToken) {
                    logger.warn('config', 'API_TOKEN is off; attack and stop endpoints are unauthenticated');
                }

                logger.ready(`listening on ${config.host}:${config.port} · ctrl+c to stop`);
                resolve();
            });
        });
    }

    async function stop(signal = 'SIGTERM') {
        logger.shutdown(`shutting down (${signal})`);
        await shutdown(ctx, ctx.server);
        logger.shutdown('stopped');
    }

    return { ctx, server: ctx.server, logger, start, shutdown: stop };
}

module.exports = { createApp };