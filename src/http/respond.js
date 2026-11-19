function sendJson(response, status, body, headers = {}) {
    const payload = JSON.stringify({ ok: status < 400, ...body });
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
    });
    response.end(payload);
}

function readJsonBody(request, limit = 8 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let failed = false;
        const chunks = [];

        request.on('data', (chunk) => {
            if (failed) {
                return;
            }
            size += chunk.length;
            if (size > limit) {
                failed = true;
                const error = new Error('Request body too large');
                error.statusCode = 413;
                reject(error);
                request.resume();
                return;
            }
            chunks.push(chunk);
        });

        request.on('end', () => {
            if (failed) {
                return;
            }
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                const error = new Error('Body must be JSON');
                error.statusCode = 400;
                reject(error);
            }
        });

        request.on('error', (error) => {
            if (!failed) {
                failed = true;
                reject(error);
            }
        });
    });
}

function single(searchParams, name) {
    const values = searchParams.getAll(name);
    return values.length === 1 ? values[0] : undefined;
}

function duplicated(searchParams, name) {
    return searchParams.getAll(name).length > 1;
}

module.exports = { sendJson, readJsonBody, single, duplicated };