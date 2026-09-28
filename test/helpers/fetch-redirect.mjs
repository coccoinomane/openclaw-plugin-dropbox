// Test-only preload (node --import). Redirects the wrapper's fixed Dropbox
// token endpoint to a local test server and refuses every other URL, so a
// misconfigured test can never reach the network.
const target = process.env.DROPBOX_TEST_TOKEN_URL;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url === "https://api.dropboxapi.com/oauth2/token") {
    if (!target) throw new Error("fetch-redirect preload: DROPBOX_TEST_TOKEN_URL is not set");
    return realFetch(target, init);
  }
  throw new Error(`fetch-redirect preload: unexpected fetch to ${url}`);
};
