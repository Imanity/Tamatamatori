// A request that never got an HTTP answer (connection, DNS, TLS, a timeout or a body cut off)
// says nothing about the data. The feeds keep what they published, note the failure and try
// again on the next schedule; HTTP errors and invalid data still pause until a maintainer resumes.
// Decided 2026-11-12 after one such failure paused the station feed for a day.

export class TransportError extends Error {
  constructor(host, cause) {
    super(`${host} 暂时无法连接（${reason(cause)}）`, { cause });
    this.name = 'TransportError';
  }
}

function reason(error) {
  if (error?.name === 'TimeoutError') return '超时';
  return error?.cause?.code ?? error?.message ?? '网络错误';
}

/** Undici reports transport failures as `TypeError: fetch failed` (or `terminated` mid-body); timeouts as `TimeoutError`. */
export function isTransportFailure(error) {
  return error instanceof Error &&
    (error.name === 'TimeoutError' || (error instanceof TypeError && /fetch failed|terminated|network|socket/i.test(error.message)));
}

/** Runs one network step and turns a transport failure into a `TransportError`; anything else passes through. */
export async function overNetwork(host, step) {
  try {
    return await step();
  } catch (error) {
    throw isTransportFailure(error) ? new TransportError(host, error) : error;
  }
}
