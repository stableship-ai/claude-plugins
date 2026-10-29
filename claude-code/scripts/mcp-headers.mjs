// headersHelper for the plugin's Stableship MCP server: Claude Code runs it when it connects and sends the headers it
// prints. With a saved login (`stableship login`, ~/.config/stableship/config.json) the server is signed in with it, so
// nobody has to run /mcp → Authenticate. Without one, or with a token Stableship no longer accepts, it prints {} and
// Claude Code signs in with OAuth as before. Never fails: anything unexpected prints {}.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { apiBase, apiToken } from './lib.mjs';

/**
 * The headers for this connection. A token the API refuses (401/403) is left out so OAuth can take over; an
 * unreachable API keeps it (the connection would fail either way, and works once the API is back).
 * @param {string} token
 * @param {string | undefined} apiUrl
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Record<string, string>>}
 */
export async function headersFor(token, apiUrl, fetchImpl = fetch) {
  if (!token) return {};
  try {
    const res = await fetchImpl(`${apiBase(apiUrl)}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'stableship-claude-code-plugin' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401 || res.status === 403) return {};
  } catch {
    // Unreachable: keep the token.
  }
  return { Authorization: `Bearer ${token}` };
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  headersFor(apiToken(), process.env.STABLESHIP_API_URL)
    .then((h) => process.stdout.write(JSON.stringify(h)))
    .catch(() => process.stdout.write('{}'));
}
