// Maps qwen-code ChatRecord lines (Gemini-CLI lineage) into the claude-dialect
// JSONL that src/main/db.ts:ingestLine reads. Pure + total: never throws, returns
// null for records with no ingestible signal.
//
// Field-name decisions (verified against real qwen-code source 2026-08-24):
//   • usageMetadata: promptTokenCount / candidatesTokenCount / cachedContentTokenCount
//       — matches @google/genai GenerateContentResponseUsageMetadata (confirmed)
//   • message: Content from @google/genai → { role?, parts?: Part[] }
//       — the brief's draft assumed `content[]`; real field is `parts[]` (corrected)
//   • Part fields: text / functionCall{name,args,id} / functionResponse{name,response}
//       — matches @google/genai Part type (confirmed)
//   • toolCallResult: { callId, status, ... } where status values include 'success'/'error'
//       — matches ToolCallResponseInfo from turn.ts + Status type (confirmed)

type Rec = Record<string, unknown>;
const asObj = (v: unknown): Rec => (v && typeof v === 'object' ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function usage(rec: Rec): Rec | undefined {
  const u = asObj(rec.usageMetadata);
  if (!('promptTokenCount' in u) && !('candidatesTokenCount' in u)) return undefined;
  return {
    input_tokens: Number(u.promptTokenCount ?? 0),
    output_tokens: Number(u.candidatesTokenCount ?? 0),
    cache_read_input_tokens: Number(u.cachedContentTokenCount ?? 0),
    cache_creation_input_tokens: 0,
    service_tier: 'standard'
  };
}

function content(rec: Rec): string | unknown[] {
  const msg = asObj(rec.message);
  // Real @google/genai Content type uses `parts[]` (not `content[]` as the
  // brief draft assumed). Verified against qwen-code chatRecordingService.ts.
  const parts = asArr(msg.parts);
  const out: unknown[] = [];
  const textChunks: string[] = [];
  for (const p of parts) {
    const part = asObj(p);
    if (typeof part.text === 'string') {
      textChunks.push(part.text);
    } else if (part.functionCall) {
      const fc = asObj(part.functionCall);
      // @google/genai FunctionCall has id, name, args fields. Prefer fc.id when present.
      out.push({
        type: 'tool_use',
        id: String(fc.id ?? cryptoId()),
        name: String(fc.name ?? ''),
        input: fc.args ?? {}
      });
    } else if (part.functionResponse) {
      const tcr = asObj(rec.toolCallResult);
      // toolCallResult.callId is the tool_use_id for pairing; status 'error' maps to is_error.
      // part.functionResponse.response is the conventional Gemini FunctionResponse envelope.
      out.push({
        type: 'tool_result',
        tool_use_id: String(tcr.callId ?? ''),
        is_error: tcr.status === 'error',
        content: JSON.stringify(asObj(part.functionResponse).response ?? {})
      });
    }
  }
  // user records with only plain text: db.ts fills first_user_message ONLY when
  // message.content is a bare string (db.ts ingestLine: `typeof message?.content === 'string'`).
  // Return the joined text as a string so the title is populated correctly.
  // tool_result records (folded into a user-type line) or records with tool blocks
  // keep content as an array.
  if (rec.type === 'user' && !out.length) return textChunks.join('');
  if (textChunks.length) out.unshift({ type: 'text', text: textChunks.join('') });
  return out;
}

let counter = 0;
// ids only need per-file uniqueness for tool_use/tool_result pairing.
function cryptoId(): string { return `tu_${Date.now().toString(36)}_${counter++}`; }

export function mapQwenRecord(raw: unknown): string | null {
  const rec = asObj(raw);
  const type = rec.type;
  if (type !== 'user' && type !== 'assistant' && type !== 'tool_result') return null;
  const u = usage(rec);
  const line: Rec = {
    type: type === 'tool_result' ? 'user' : type,   // db.ts treats tool_result blocks inside a user turn
    uuid: rec.uuid,
    parentUuid: rec.parentUuid,
    timestamp: rec.timestamp,
    message: {
      role: type === 'assistant' ? 'assistant' : 'user',
      model: rec.model,
      content: content(rec),
      ...(u ? { usage: u } : {})
    }
  };
  return JSON.stringify(line);
}
