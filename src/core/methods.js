const fs = require('node:fs');

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PLACEHOLDER_RE = /<<([a-zA-Z]+)>>/g;
const ALLOWED = new Set(['host', 'time', 'method']);
const SHELL_META_RE = /[|;&$`<>(){}[\]\\'"\n\r\t]/;

function substitute(token, values, name) {
    return token.replace(PLACEHOLDER_RE, (_, key) => {
        if (!ALLOWED.has(key)) {
            throw new Error(`Unknown placeholder <<${key}>> in method "${name}"`);
        }
        return values['<<' + key + '>>'];
    });
}

function validateTemplate(tokens, name) {
    for (const token of tokens) {
        for (const match of token.matchAll(PLACEHOLDER_RE)) {
            if (!ALLOWED.has(match[1])) {
                throw new Error(`Unknown placeholder <<${match[1]}>> in method "${name}"`);
            }
        }
        if (token.includes('<<') || token.includes('>>')) {
            const leftover = token.replace(PLACEHOLDER_RE, '');
            if (leftover.includes('<<') || leftover.includes('>>')) {
                throw new Error(`Malformed placeholder in method "${name}"`);
            }
        }
    }
}

// method.json v2 memakai argv (tanpa shell). Template `command` lama dipecah
// menjadi token saat load dan ditolak bila mengandung metakarakter shell.
function loadMethods(file, logger) {
    const methods = new Map();
    let entries;

    try {
        entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        logger.warn('methods', 'method.json: ' + error.message);
        return methods;
    }

    if (!Array.isArray(entries)) {
        logger.warn('methods', 'method.json must be an array');
        return methods;
    }

    for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string') {
            logger.warn('methods', 'skipped entry without a string name');
            continue;
        }
        if (!NAME_RE.test(entry.name)) {
            logger.warn('methods', `skipped method with invalid name: ${entry.name}`);
            continue;
        }

        let argv = null;
        if (Array.isArray(entry.argv)) {
            if (!entry.argv.length || !entry.argv.every((token) => typeof token === 'string')) {
                logger.warn('methods', `skipped ${entry.name}: argv must be a non-empty string array`);
                continue;
            }
            argv = entry.argv.slice();
        } else if (typeof entry.command === 'string') {
            const tokens = entry.command.trim().split(/\s+/).filter(Boolean);
            if (!tokens.length || tokens.some((token) => SHELL_META_RE.test(token))) {
                logger.warn('methods', `skipped ${entry.name}: legacy command contains shell metacharacters`);
                continue;
            }
            logger.warn('methods', `${entry.name} uses deprecated "command"; migrate to "argv"`);
            argv = tokens;
        } else {
            logger.warn('methods', `skipped ${entry.name}: no argv or command`);
            continue;
        }

        try {
            validateTemplate(argv, entry.name);
        } catch (error) {
            logger.warn('methods', error.message);
            continue;
        }

        if (methods.has(entry.name)) {
            logger.warn('methods', `duplicate method "${entry.name}", last entry wins`);
        }

        methods.set(entry.name, {
            name: entry.name,
            description: typeof entry.description === 'string' ? entry.description : '',
            argv,
        });
    }

    return methods;
}

function buildJob(methods, name, target, duration, httpMethod = 'GET') {
    const method = methods.get(name);
    if (!method) {
        return null;
    }

    const values = {
        '<<host>>': target,
        '<<time>>': String(duration),
        '<<method>>': httpMethod,
    };

    return {
        argv: method.argv.map((token) => substitute(token, values, name)),
    };
}

function methodNames(methods) {
    return [...methods.keys()];
}

function methodSummary(methods) {
    return methodNames(methods).join(', ') || '(none)';
}

module.exports = { loadMethods, buildJob, methodNames, methodSummary };