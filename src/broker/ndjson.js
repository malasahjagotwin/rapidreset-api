const DEFAULT_MAX_LINE = 64 * 1024;

// Parser baris NDJSON dengan batas buffer, dipakai oleh kanal worker dan worker
// signal. Tanpa batas, peer bisa menahan memori dengan satu baris tanpa newline.
function createLineReader(onLine, { maxLine = DEFAULT_MAX_LINE, onOverflow } = {}) {
    let buffer = '';

    return (chunk) => {
        buffer += chunk.toString('utf8');

        if (buffer.length > maxLine) {
            buffer = '';
            if (onOverflow) {
                onOverflow();
            }
            return;
        }

        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
                onLine(line);
            }
        }
    };
}

module.exports = { createLineReader };