import { JobInputError } from "./job.ts";
import { assertPublicUrl } from "./ssrf.ts";

const MAX_REDIRECTS = 5;

/** fetch() that re-validates every redirect hop against the SSRF policy and caps body size. */
export async function safeFetch(raw: string, maxBytes: number, signal: AbortSignal) {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = await assertPublicUrl(new URL(location, url).href);
      continue;
    }
    if (!res.ok) throw new JobInputError(`fetching ${url.href} failed with HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes)
      throw new JobInputError(`document exceeds ${maxBytes} bytes`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > maxBytes) throw new JobInputError(`document exceeds ${maxBytes} bytes`);
    return { url, body, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }
  throw new JobInputError("too many redirects");
}
