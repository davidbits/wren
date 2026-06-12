/** Stream a (possibly large) text file line by line without buffering it whole. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}
