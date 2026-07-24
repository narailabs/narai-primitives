const fs = require('fs');
let content = fs.readFileSync('src/toolkit/fetch_helper.ts', 'utf-8');

// The code review suggested wrapping the rest in a finally block to ensure clearTimeout is always called, even if reader.read() throws.
// Let's refactor `fetchWithCaps` to use a single try...finally for the entire logic.

// Replace from `let response: Response;` to the end of the file.
content = content.replace(/let response: Response;[\s\S]+/, `let response: Response;
  try {
    response = await fetch(url, { ...init, signal });

    const clHeader = response.headers.get("content-length");
    if (clHeader !== null) {
      const cl = Number(clHeader);
      if (Number.isFinite(cl) && cl > maxBytes) {
        try {
          await response.body?.cancel();
        } catch {
          /* best-effort */
        }
        throw new FetchCapExceeded(maxBytes, cl, url);
      }
    }

    const reader = response.body?.getReader();
    if (reader === undefined) {
      return response;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
        throw new FetchCapExceeded(maxBytes, total, url);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new Response(merged, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}`);

fs.writeFileSync('src/toolkit/fetch_helper.ts', content);
