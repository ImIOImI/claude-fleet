// src/main/qwenAdapter.ts
var asObj = (v) => v && typeof v === "object" ? v : {};
var asArr = (v) => Array.isArray(v) ? v : [];
function usage(rec) {
  const u = asObj(rec.usageMetadata);
  if (!("promptTokenCount" in u) && !("candidatesTokenCount" in u)) return void 0;
  return {
    input_tokens: Number(u.promptTokenCount ?? 0),
    output_tokens: Number(u.candidatesTokenCount ?? 0),
    cache_read_input_tokens: Number(u.cachedContentTokenCount ?? 0),
    cache_creation_input_tokens: 0,
    service_tier: "standard"
  };
}
function content(rec) {
  const msg = asObj(rec.message);
  const parts = asArr(msg.parts);
  const out = [];
  const textChunks = [];
  for (const p of parts) {
    const part = asObj(p);
    if (typeof part.text === "string") {
      textChunks.push(part.text);
    } else if (part.functionCall) {
      const fc = asObj(part.functionCall);
      out.push({
        type: "tool_use",
        id: String(fc.id ?? cryptoId()),
        name: String(fc.name ?? ""),
        input: fc.args ?? {}
      });
    } else if (part.functionResponse) {
      const tcr = asObj(rec.toolCallResult);
      out.push({
        type: "tool_result",
        tool_use_id: String(tcr.callId ?? ""),
        is_error: tcr.status === "error",
        content: JSON.stringify(asObj(part.functionResponse).response ?? {})
      });
    }
  }
  if (rec.type === "user" && !out.length) return textChunks.join("");
  if (textChunks.length) out.unshift({ type: "text", text: textChunks.join("") });
  return out;
}
var counter = 0;
function cryptoId() {
  return `tu_${Date.now().toString(36)}_${counter++}`;
}
function mapQwenRecord(raw) {
  const rec = asObj(raw);
  const type = rec.type;
  if (type !== "user" && type !== "assistant" && type !== "tool_result") return null;
  const u = usage(rec);
  const line = {
    type: type === "tool_result" ? "user" : type,
    // db.ts treats tool_result blocks inside a user turn
    uuid: rec.uuid,
    parentUuid: rec.parentUuid,
    timestamp: rec.timestamp,
    message: {
      role: type === "assistant" ? "assistant" : "user",
      model: rec.model,
      content: content(rec),
      ...u ? { usage: u } : {}
    }
  };
  return JSON.stringify(line);
}
export {
  mapQwenRecord
};
