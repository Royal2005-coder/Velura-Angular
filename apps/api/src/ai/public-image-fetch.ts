import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(address, prefix, "ipv6");

/** Resolve and pin a public CDN address so hostname allowlists cannot be bypassed by DNS rebinding. */
export async function fetchPublicCatalogImage(url: URL, options: RequestInit): Promise<Response> {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("CATALOG_TRANSPORT_DENIED");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => blocked.check(entry.address, entry.family === 4 ? "ipv4" : "ipv6") || !isIP(entry.address))) throw new Error("CATALOG_NETWORK_DENIED");
  const selected = addresses[0]!;
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: "GET", signal: options.signal || undefined,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      },
      headers: { accept: "image/jpeg,image/png,image/webp" },
    }, response => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (typeof value === "string") headers.set(key, value);
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode || 502, headers }));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("CATALOG_FETCH_TIMEOUT")));
    req.end();
  });
}
