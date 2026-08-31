export type ColabBootstrapSource = {
  code: string;
  marker: string;
};

export function buildColabBootstrapSource(options: {
  sessionId: string;
  encodedPayload: string;
  payloadSha256: string;
  compressed: boolean;
  chunkSize?: number;
}): ColabBootstrapSource {
  const chunkSize = Math.max(120, Math.min(800, Math.floor(options.chunkSize || 480)));
  const chunks = options.encodedPayload.match(new RegExp(`.{1,${chunkSize}}`, "gu")) || [];
  const marker = `NLM_BOOTSTRAP_END_${options.payloadSha256.slice(0, 16)}`;
  const code = [
    `NLM_SESSION_ID=${JSON.stringify(options.sessionId)}`,
    "import base64,hashlib" + (options.compressed ? ",gzip" : ""),
    "_NLM_PAYLOAD = (",
    ...chunks.map((chunk) => JSON.stringify(chunk)),
    ")",
    "_nlm_bytes = base64.b64decode(_NLM_PAYLOAD)",
    `_nlm_expected = ${JSON.stringify(options.payloadSha256)}`,
    "if hashlib.sha256(_nlm_bytes).hexdigest() != _nlm_expected: raise RuntimeError('NotebookLM bridge payload checksum mismatch')",
    options.compressed ? "_nlm_source = gzip.decompress(_nlm_bytes)" : "_nlm_source = _nlm_bytes",
    "exec(compile(_nlm_source.decode('utf-8'), 'notebooklm_facebook_bridge.py', 'exec'))",
    `# ${marker}`
  ].join("\n");
  return { code, marker };
}
