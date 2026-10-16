/** Decompresses a gzip payload with the platform `DecompressionStream` (browsers, Node ≥ 18). */
export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(data); // an ArrayBuffer-backed copy, as the stream API expects
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
