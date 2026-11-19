const path = require('node:path');

const DEFAULTS = Object.freeze({
    maxAttackTime: 300,
    maxQueuedJobs: 32,
    minJobTimeoutMs: 60_000,
    jobTimeoutGraceMs: 30_000,
    cancelTimeoutMs: 10_000,
});

function loadConfig(env = process.env) {
    const port = Number(env.PORT || env.SERVER_PORT || 3295);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535');
    }

    return {
        port,
        host: env.HOST || '0.0.0.0',
        clientToken: env.CLIENT_TOKEN || '',
        apiToken: env.API_TOKEN || '',
        methodsFile: env.METHODS_FILE
            ? path.resolve(env.METHODS_FILE)
            : path.join(__dirname, '..', '..', 'method.json'),
        ...DEFAULTS,
    };
}

module.exports = { loadConfig };