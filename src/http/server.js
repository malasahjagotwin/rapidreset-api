const http = require('node:http');
const { sendJson } = require('./respond');

function createServer(ctx) {
    const server = http.createServer(
        {
            headersTimeout: 10_000,
            requestTimeout: 15_000,
            maxHeaderSize: 16 * 1024,
        },
        (request, response) => {
            Promise.resolve()
                .then(() => ctx.routes.route(request, response))
                .catch((error) => {
                    ctx.logger.fail('http', 'request handler: ' + ctx.logger.describe(error));
                    if (!response.headersSent) {
                        sendJson(response, 500, { error: 'Internal error' });
                    } else {
                        response.destroy();
                    }
                });
        },
    );

    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname !== '/api/worker') {
            socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
            return;
        }

        if (head && head.length > 0) {
            socket.unshift(head);
        }

        ctx.workerSocket.handle(socket, request);
    });

    server.on('clientError', (error, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
        } else {
            socket.destroy();
        }
    });

    server.keepAliveTimeout = 5_000;

    server.on('error', (error) => {
        ctx.logger.fail('server', ctx.logger.describe(error));
        if (error.code === 'EADDRINUSE') {
            ctx.logger.fail('server', `port ${ctx.config.port} is already in use; set PORT or stop the other process`);
        }
    });

    return server;
}

function shutdown(ctx, server) {
    if (ctx.state.shuttingDown) {
        return Promise.resolve();
    }

    ctx.state.shuttingDown = true;
    ctx.jobs.shutdown();
    ctx.workers.endAll();

    return new Promise((resolve) => {
        const force = setTimeout(resolve, 2_000);
        force.unref();

        server.close(() => {
            clearTimeout(force);
            resolve();
        });

        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
    });
}

module.exports = { createServer, shutdown };