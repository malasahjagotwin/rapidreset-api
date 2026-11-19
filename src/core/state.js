// Satu-satunya pemilik struktur state broker. Modul lain memutasi map lewat
// API service, bukan dengan mengganti referensinya (pending harus tetap array).
function createState() {
    return {
        jobs: new Map(),
        pending: [],
        workers: new Map(),
        waiters: new Map(),
        shuttingDown: false,
    };
}

module.exports = { createState };