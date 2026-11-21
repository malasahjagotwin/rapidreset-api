const path = require('node:path');

const DEFAULT_MAX_ATTACK_TIME = 86400;
const MAX_ATTACK_TIME_LIMIT = 2_000_000;
const DEFAULTS = Object.freeze({
    maxQueuedJobs: 32,
    minJobTimeoutMs: 60_000,
    jobTimeoutGraceMs: 30_000,
    cancelTimeoutMs: 10_000,
});

function loadConfig(env = process.env) {
    const port = Number(env.PORT || env.SERVER_PORT || 9215);
    const maxAttackTime = Number(env.MAX_ATTACK_TIME || DEFAULT_MAX_ATTACK_TIME);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535');
    }
    if (!Number.isInteger(maxAttackTime) || maxAttackTime < 1 || maxAttackTime > MAX_ATTACK_TIME_LIMIT) {
        throw new Error(`MAX_ATTACK_TIME must be an integer between 1 and ${MAX_ATTACK_TIME_LIMIT}`);
    }

    return {
        port,
        host: env.HOST || '0.0.0.0',
        clientToken: env.CLIENT_TOKEN || '',
        apiToken: env.API_TOKEN || '',
        methodsFile: env.METHODS_FILE
            ? path.resolve(env.METHODS_FILE)
            : path.join(__dirname, '..', '..', 'method.json'),
        maxAttackTime,
        ...DEFAULTS,
    };
}

module.exports = { loadConfig, DEFAULT_MAX_ATTACK_TIME };