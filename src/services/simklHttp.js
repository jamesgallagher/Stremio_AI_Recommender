// A deadline for the complete auth request, including optional body parsing.
// Abort is best-effort; the deadline settles even if the transport ignores it.
const TIMEOUT_MS = 10000;

async function request(url, options = {}, read = response => response) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Simkl unreachable (timeout)'));
      controller.abort();
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => read(await fetch(url, { ...options, signal: controller.signal })))(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(url, options) {
  return request(url, options, async response => ({
    response,
    data: await response.json().catch(() => null),
  }));
}

module.exports = { request, json };
