const crypto = require('node:crypto');

function createJobs(ctx) {
    const { state } = ctx;

    function submit({ name, target, time, argv }) {
        const job = {
            id: crypto.randomUUID(),
            name,
            target,
            time,
            argv,
            queuedAt: Date.now(),
            workerId: null,
            channel: null,
            cancelling: false,
            done: false,
            timer: null,
        };

        state.jobs.set(job.id, job);
        state.pending.push(job);
        return job;
    }

    function get(id) {
        return state.jobs.get(id) || null;
    }

    function publicJob(job) {
        return {
            id: job.id,
            name: job.name,
            target: job.target,
            time: job.time,
            argv: job.argv,
            channel: job.channel,
        };
    }

    function statusOf(job) {
        if (job.cancelling && job.workerId) {
            return 'stopping';
        }
        return job.workerId ? 'running' : 'queued';
    }

    function release(job) {
        if (job.timer) {
            clearTimeout(job.timer);
            job.timer = null;
        }
        if (job.workerId) {
            ctx.workers.release(job.id, job.workerId);
        }
    }

    function finish(job, exitCode, output, cancelled = false) {
        if (job.done) {
            return;
        }

        job.done = true;
        job.cancelling = false;
        release(job);

        const verdict = cancelled ? 'cancelled' : exitCode === 0 ? 'done' : 'failed';
        const elapsed = ((Date.now() - job.queuedAt) / 1000).toFixed(1);
        state.jobs.delete(job.id);

        if (verdict === 'done') {
            ctx.logger.ok('job', `${job.id.slice(0, 8)} done  exit=${exitCode}  ${elapsed}s`);
        } else if (verdict === 'cancelled') {
            ctx.logger.warn('job', `${job.id.slice(0, 8)} cancelled  ${elapsed}s`);
        } else {
            ctx.logger.fail('job', `${job.id.slice(0, 8)} failed  exit=${exitCode}  ${elapsed}s`);
        }

        ctx.scheduler.dispatch();
    }

    function fail(job, message, cancel = false) {
        if (job.done) {
            return;
        }

        if (cancel) {
            const target = ctx.workers.getTarget(job);
            if (target) {
                try {
                    target.send({ type: 'cancel', id: job.id });
                } catch {
                    // kanal sudah mati; timeout tetap menyelesaikan job
                }
            }
        }

        job.done = true;
        release(job);
        state.jobs.delete(job.id);
        ctx.logger.fail('job', `${job.id.slice(0, 8)} failed  ${message}`);
        ctx.scheduler.dispatch();
    }

    function cancel(job) {
        if (job.done) {
            return 'already-finished';
        }

        if (!job.workerId) {
            job.done = true;
            ctx.scheduler.removePending(job);
            state.jobs.delete(job.id);
            ctx.logger.warn('job', `${job.id.slice(0, 8)} cancelled  removed from queue`);
            ctx.scheduler.dispatch();
            return 'cancelled';
        }

        const target = ctx.workers.getTarget(job);
        if (!target) {
            fail(job, 'Worker gone before the stop request');
            return 'cancelled';
        }

        job.cancelling = true;
        if (job.timer) {
            clearTimeout(job.timer);
        }
        job.timer = setTimeout(() => finish(job, null, '', true), ctx.config.cancelTimeoutMs);

        try {
            target.send({ type: 'cancel', id: job.id });
        } catch (error) {
            fail(job, 'Stop request failed: ' + error.message);
            return 'cancelled';
        }

        ctx.logger.warn('job', `${job.id.slice(0, 8)} stopping → ${job.workerId}`);
        return 'stopping';
    }

    function shutdown(message = 'Orchestrator shutting down') {
        for (const job of [...state.jobs.values()]) {
            const target = ctx.workers.getTarget(job);
            if (target) {
                try {
                    target.send({ type: 'cancel', id: job.id });
                } catch {
                    // ignore
                }
            }
            if (job.timer) {
                clearTimeout(job.timer);
            }
            job.done = true;
        }

        state.jobs.clear();
        state.pending.length = 0;
        ctx.logger.info('broker', message);
    }

    return {
        submit,
        get,
        publicJob,
        statusOf,
        finish,
        fail,
        cancel,
        shutdown,
    };
}

module.exports = { createJobs };