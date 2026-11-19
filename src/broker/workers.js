function createWorkers(ctx) {
    const { state } = ctx;

    function list() {
        return [...state.workers.values()];
    }

    function publicWorker(worker) {
        const jobs = [...worker.jobs];
        return {
            id: worker.id,
            name: worker.name,
            version: worker.version,
            connectedAt: worker.connectedAt,
            slots: worker.slots,
            currentJobId: jobs[0] || null,
            jobs: jobs.length,
        };
    }

    function pickIdleWorker() {
        for (const worker of state.workers.values()) {
            if (worker.jobs.size < worker.slots) {
                return worker;
            }
        }
        return null;
    }

    // Worker yang punya kanal control selalu dipakai lebih dulu; waiter hanya
    // untuk worker yang Upgrade-nya diblokir.
    function pickWaiter() {
        for (const waiter of state.waiters.values()) {
            if (waiter.jobs.size >= waiter.slots) {
                continue;
            }
            if (state.workers.has(waiter.id)) {
                continue;
            }
            return waiter;
        }
        return null;
    }

    function registerSocket(worker) {
        state.workers.set(worker.id, worker);
    }

    function removeSocket(worker, reason = 'Worker disconnected before finishing the job') {
        if (state.workers.get(worker.id) !== worker) {
            return;
        }

        state.workers.delete(worker.id);
        ctx.logger.warn('worker', `${worker.id} disconnected`);

        for (const job of [...state.jobs.values()]) {
            if (job.workerId === worker.id && job.channel === 'control') {
                ctx.jobs.fail(job, reason);
            }
        }

        ctx.scheduler.dispatch();
    }

    function registerWaiter(waiter) {
        state.waiters.set(waiter.id, waiter);
    }

    function removeWaiter(waiter) {
        if (state.waiters.get(waiter.id) === waiter) {
            state.waiters.delete(waiter.id);
        }
    }

    function getTarget(job) {
        if (job.channel === 'signal') {
            return state.waiters.get(job.workerId) || state.workers.get(job.workerId) || null;
        }
        return state.workers.get(job.workerId) || state.waiters.get(job.workerId) || null;
    }

    function release(jobId, workerId) {
        const worker = state.workers.get(workerId);
        if (worker) {
            worker.jobs.delete(jobId);
        }
        const waiter = state.waiters.get(workerId);
        if (waiter) {
            waiter.jobs.delete(jobId);
        }
    }

    function endAll() {
        for (const worker of state.workers.values()) {
            worker.socket.end();
        }
        for (const waiter of state.waiters.values()) {
            waiter.close();
        }
        state.workers.clear();
        state.waiters.clear();
    }

    return {
        list,
        publicWorker,
        pickIdleWorker,
        pickWaiter,
        registerSocket,
        removeSocket,
        registerWaiter,
        removeWaiter,
        getTarget,
        release,
        endAll,
        waiterCount: () => state.waiters.size,
    };
}

module.exports = { createWorkers };