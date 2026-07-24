/**
 * Wire handshake preflight.
 *
 * Answers the question "has Cursor moved the protocol out from under us?"
 * without needing a full chat turn: it performs the real Connect/HTTP2
 * handshake against the configured agent endpoint, decodes the response with
 * our generated schema, and reports any unknown fields — the earliest signal
 * that `proto/agent.proto` is behind.
 *
 * Usage: CURSOR_ACCESS_TOKEN=... node --import tsx scripts/smoke-wire.mjs
 */
import { fromBinary } from "@bufbuild/protobuf";

import { GetUsableModelsResponseSchema } from "../src/proto/agent_pb.ts";
import { callCursorUnaryRpc } from "../src/stream/model-discovery.ts";
import { getCursorAgentUrl, getCursorClientVersion } from "../src/stream/config.ts";
import { getDriftSignals, recordUnknownFields } from "../src/stream/drift.ts";
import { create, toBinary } from "@bufbuild/protobuf";
import { GetUsableModelsRequestSchema } from "../src/proto/agent_pb.ts";

const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("Set CURSOR_ACCESS_TOKEN (or run /login cursor and copy access from auth.json)");
  process.exit(1);
}

const endpoint = getCursorAgentUrl();
const clientVersion = getCursorClientVersion();
console.log(`endpoint:      ${endpoint}`);
console.log(`clientVersion: ${clientVersion}`);

const requestBody = toBinary(
  GetUsableModelsRequestSchema,
  create(GetUsableModelsRequestSchema, {}),
);

const { body, exitCode, timedOut } = await callCursorUnaryRpc({
  accessToken: token,
  rpcPath: "/agent.v1.AgentService/GetUsableModels",
  requestBody,
  timeoutMs: 15_000,
});

if (timedOut) {
  console.error("smoke-wire: FAILED — handshake timed out (endpoint unreachable or wrong)");
  process.exit(1);
}
if (exitCode !== 0) {
  console.error(`smoke-wire: FAILED — bridge exited ${exitCode}`);
  process.exit(1);
}

// Connect unary responses are a 5-byte framed envelope around the message.
const payload = body.length > 5 ? body.subarray(5) : body;

let response;
try {
  response = fromBinary(GetUsableModelsResponseSchema, payload);
} catch (error) {
  console.error(`smoke-wire: FAILED — response did not decode with our schema: ${error}`);
  console.error("The agent schema has likely drifted. See proto/README.md.");
  process.exit(1);
}

console.log(`models:        ${response.models.length}`);

recordUnknownFields("GetUsableModelsResponse", response);
for (const model of response.models) recordUnknownFields("ModelDetails", model);

const drift = getDriftSignals();
if (drift.length > 0) {
  console.warn("smoke-wire: schema drift detected — Cursor sent fields we do not model:");
  for (const s of drift) console.warn(`  ${s.kind}: ${s.detail} (x${s.count})`);
  console.warn("This is usually harmless, but see proto/README.md to resync the schema.");
} else {
  console.log("drift:         none");
}

console.log("smoke-wire: ok");
