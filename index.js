const { createApp } = require('./src/app');

let app;

try {
    app = createApp();
} catch (error) {
    console.error('config: ' + (error && error.message ? error.message : error));
    process.exit(1);
}

let stopping = false;

function stop(signal) {
    if (stopping) {
        process.exit(130);
    }

    stopping = true;
    app.shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
            app.logger.fail('process', app.logger.describe(error));
            process.exit(1);
        });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

process.on('uncaughtException', (error) => {
    app.logger.fail('process', error && error.stack ? error.stack : app.logger.describe(error));
    stop('uncaughtException');
});

process.on('unhandledRejection', (error) => {
    app.logger.fail('process', error && error.stack ? error.stack : app.logger.describe(error));
});

app.start().catch((error) => {
    app.logger.fail('server', app.logger.describe(error));
    process.exit(1);
});