const crypto = require('node:crypto');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_TARGET_LENGTH = 2048;

function isValidTarget(value) {
    if (typeof value !== 'string' || value.length < 8 || value.length > MAX_TARGET_LENGTH) {
        return false;
    }
    if (/\s/.test(value) || CONTROL_RE.test(value)) {
        return false;
    }

    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
    } catch {
        return false;
    }
}

function normalizeTarget(value) {
    return new URL(value).href;
}

// Log tidak perlu menyimpan kredensial URL atau query string.
function displayTarget(value) {
    try {
        const url = new URL(value);
        return (url.origin + url.pathname).slice(0, 120);
    } catch {
        return String(value).slice(0, 120);
    }
}

function isValidDuration(value, maxAttackTime) {
    if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) {
        return false;
    }
    const duration = Number(value);
    return duration >= 1 && duration <= maxAttackTime;
}

function isValidMethod(methods, name) {
    return typeof name === 'string' && ID_RE.test(name) && methods.has(name);
}

function isValidWorkerId(value) {
    return typeof value === 'string' && ID_RE.test(value);
}

function safeEqual(expected, value) {
    if (typeof value !== 'string') {
        return false;
    }
    const left = Buffer.from(expected);
    const right = Buffer.from(value);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function tokenMatches(expected, value) {
    if (!expected) {
        return true;
    }
    return safeEqual(expected, value);
}

function apiTokenMatches(expected, request) {
    if (!expected) {
        return true;
    }

    const header = request.headers['x-api-token'];
    if (typeof header === 'string') {
        return safeEqual(expected, header);
    }

    const authorization = request.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
        return safeEqual(expected, authorization.slice('Bearer '.length));
    }

    return false;
}

module.exports = {
    isValidTarget,
    normalizeTarget,
    displayTarget,
    isValidDuration,
    isValidMethod,
    isValidWorkerId,
    tokenMatches,
    apiTokenMatches,
};