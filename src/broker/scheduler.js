const { displayTarget } = require('../core/validation');

function createScheduler(ctx) {
    const { state } = ctx;

    function timeoutFor(job) {
        return Math.max(
            ctx.config.minJobTimeoutMs,
            Number(job.time) * 1000 + ctx.config.jobTimeoutGraceMs,
        );
    }

    function assign(target, channel) {
        const job = state.pending.shift();
        job.workerId = target.id;
        job.channel = channel;
        target.jobs.add(job.id);

        job.timer = setTimeout(() => {
            ctx.jobs.fail(job, `Worker ${target.id} did not finish the job in time`, true);
        }, timeoutFor(job));

        try {
            target.send({ type: 'job', job: ctx.jobs.publicJob(job) });
        } catch (error) {
            ctx.jobs.fail(job, 'Dispatch failed: ' + error.message);
            return;
        }

        ctx.logger.info(
            'job',
            `${job.id.slice(0, 8)} → ${target.id} (${channel})  ${job.name} ${displayTarget(job.target)} ${job.time}s`,
        );
    }

    function dispatch() {
        if (state.shuttingDown) {
            return;
        }

        while (state.pending.length > 0) {
            const worker = ctx.workers.pickIdleWorker();
            if (worker) {
                assign(worker, 'control');
                continue;
            }

            const waiter = ctx.workers.pickWaiter();
            if (!waiter) {
                return;
            }
            assign(waiter, 'signal');
        }
    }

    function canAccept() {
        return Boolean(ctx.workers.pickIdleWorker() || ctx.workers.pickWaiter())
            || state.pending.length < ctx.config.maxQueuedJobs;
    }

    function removePending(job) {
        const index = state.pending.indexOf(job);
        if (index === -1) {
            return false;
        }
        state.pending.splice(index, 1);
        return true;
    }

    return { dispatch, canAccept, removePending };
}

module.exports = { createScheduler };