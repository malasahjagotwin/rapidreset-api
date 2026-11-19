const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const COLOR = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
};
const LABEL_WIDTH = 9;
const RULE = '─'.repeat(46);

function forceColor(env) {
    if (!Object.prototype.hasOwnProperty.call(env, 'FORCE_COLOR')) {
        return null;
    }
    const value = String(env.FORCE_COLOR).toLowerCase();
    return value !== '0' && value !== 'false';
}

function supportsColor(stream, env) {
    const forced = forceColor(env);
    if (forced !== null) {
        return forced;
    }
    if (env.NO_COLOR) {
        return false;
    }
    if (!stream.isTTY || env.TERM === 'dumb') {
        return false;
    }
    if (process.platform === 'win32') {
        return Boolean(
            env.WT_SESSION ||
            env.TERM_PROGRAM ||
            env.ConEmuANSI === 'ON' ||
            env.ANSICON,
        );
    }
    return true;
}

function clock() {
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function createLogger({ env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
    const threshold = LEVELS[String(env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
    const format = String(env.LOG_FORMAT || (stdout.isTTY ? 'pretty' : 'json')).toLowerCase();

    for (const stream of [stdout, stderr]) {
        stream.on?.('error', (error) => {
            if (error && error.code === 'EPIPE') {
                process.exit(0);
            }
        });
    }

    function paint(stream, codes, text) {
        return supportsColor(stream, env) ? codes + text + COLOR.reset : String(text);
    }

    function fieldsText(fields, stream) {
        const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null);
        if (entries.length === 0) {
            return '';
        }
        return '  ' + entries
            .map(([key, value]) => paint(stream, COLOR.dim, key) + '=' + String(value))
            .join(' ');
    }

    function emit(level, icon, tone, stream, scope, message, fields = {}) {
        if (LEVELS[level] > threshold) {
            return;
        }

        if (format === 'json') {
            stream.write(JSON.stringify({
                ts: new Date().toISOString(),
                level,
                scope,
                msg: message,
                ...fields,
            }) + '\n');
            return;
        }

        const label = paint(stream, COLOR.dim, String(scope).padEnd(LABEL_WIDTH));
        stream.write('  ' + paint(stream, COLOR.dim, clock()) + '  ' + paint(stream, tone, icon) + ' ' + label + '  ' + message + fieldsText(fields, stream) + '\n');
    }

    function banner({ version, node, listen, local, methods, token }) {
        if (format === 'json') {
            emit('info', '›', COLOR.cyan, stdout, 'broker', 'banner', { version, node, listen, local, methods, token: token || 'off' });
            return;
        }

        const rule = '  ' + paint(stdout, COLOR.gray, RULE);
        const field = (name, value) => {
            stdout.write('  ' + paint(stdout, COLOR.dim, name.padEnd(10)) + '  ' + value + '\n');
        };

        stdout.write('\n');
        stdout.write('  ' + paint(stdout, COLOR.bold + COLOR.magenta, '⚡ RAPIDRESET') + '\n');
        stdout.write('  ' + paint(stdout, COLOR.dim, 'orchestration broker · HTTP/2 rapid reset') + '\n');
        stdout.write(rule + '\n');
        field('version', paint(stdout, COLOR.bold, version || '-'));
        field('node', node || process.version);
        field('listen', listen);
        if (local) {
            field('local', local);
        }
        field('methods', methods);
        const tokenOff = !token || token === 'off';
        field('token', tokenOff ? paint(stdout, COLOR.dim, 'off') : paint(stdout, COLOR.yellow, token));
        stdout.write(rule + '\n\n');
    }

    function ready(message) {
        if (format === 'json') {
            emit('info', '●', COLOR.green, stdout, 'broker', message);
            return;
        }
        stdout.write('  ' + paint(stdout, COLOR.gray, RULE) + '\n');
        stdout.write('  ' + paint(stdout, COLOR.green, '●') + ' ' + paint(stdout, COLOR.bold, message) + '\n\n');
    }

    return {
        banner,
        ready,
        ok: (scope, message, fields) => emit('info', '✓', COLOR.green, stdout, scope, message, fields),
        info: (scope, message, fields) => emit('info', '›', COLOR.cyan, stdout, scope, message, fields),
        debug: (scope, message, fields) => emit('debug', '·', COLOR.gray, stdout, scope, message, fields),
        warn: (scope, message, fields) => emit('warn', '⚠', COLOR.yellow, stderr, scope, message, fields),
        fail: (scope, message, fields) => emit('error', '✕', COLOR.red, stderr, scope, message, fields),
        shutdown: (message) => emit('info', '●', COLOR.dim, stdout, 'broker', message),
        describe: (error) => (error && error.message ? error.message : String(error)),
    };
}

module.exports = { createLogger };