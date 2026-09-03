/**
 * Frontend half of the market perf instrumentation.
 *
 * The Rust spans stop at "response constructed". Everything after that — serializing a response
 * whose chart points can run to hundreds of entries, pushing it across the Tauri IPC bridge,
 * parsing it back into JS, and the React render it triggers — is invisible to them, and is a real
 * candidate: selecting an item is just as slow on a **warm** item that needs no network at all.
 *
 * Off unless asked for. Enable with `localStorage.setItem('warstonks:perf', '1')` and reload; the
 * backend half wants `WARSTONKS_PERF_LOG=1` in the environment. Both write to the same places
 * they always would, so a session can be read as one timeline.
 */

let enabled: boolean | null = null;

function perfEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = window.localStorage.getItem('warstonks:perf') === '1';
    } catch {
      // Private windows and locked-down webviews throw on access rather than returning null.
      enabled = false;
    }
  }
  return enabled;
}

/**
 * Times a command round-trip and reports the parsed payload's size.
 *
 * The size is measured with `JSON.stringify`, which is itself not free — hence the flag. It is
 * the number that says whether the bridge is worth optimising or not.
 */
export async function timedInvoke<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!perfEnabled()) {
    return run();
  }
  const started = performance.now();
  try {
    const result = await run();
    const elapsed = performance.now() - started;
    let bytes = -1;
    try {
      bytes = JSON.stringify(result)?.length ?? -1;
    } catch {
      // A payload that cannot be stringified is not one we can size; the timing still stands.
    }
    console.debug(
      `[perf] ipc ${label} elapsedMs=${elapsed.toFixed(1)} bytes=${bytes}`,
    );
    return result;
  } catch (error) {
    console.debug(
      `[perf] ipc ${label} elapsedMs=${(performance.now() - started).toFixed(1)} failed`,
    );
    throw error;
  }
}

/** Marks a span the caller times itself — used for the two-wave sequence in the store. */
export function perfMark(label: string, elapsedMs: number, extra = ''): void {
  if (!perfEnabled()) {
    return;
  }
  console.debug(`[perf] ${label} elapsedMs=${elapsedMs.toFixed(1)}${extra ? ` ${extra}` : ''}`);
}
