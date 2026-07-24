/**
 * Regenerates `proto/agent.proto` from the descriptor embedded in the current
 * `src/proto/agent_pb.ts`. Run this after dropping in a newer generated file
 * from upstream, then `npm run proto:check` to confirm the two agree.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { parseFileDescriptor, printProtoFile } from "./proto-descriptor.js";

const GENERATED = "src/proto/agent_pb.ts";
const PROTO = "proto/agent.proto";

const fd = parseFileDescriptor(readFileSync(GENERATED, "utf8"));
const text = printProtoFile(fd);
writeFileSync(PROTO, text, "utf8");

const messages = fd.messageType.length;
const enums = fd.enumType.length;
const services = fd.service.length;
console.log(
  `proto:sync: wrote ${PROTO} from ${GENERATED} ` +
    `(${messages} messages, ${enums} enums, ${services} services)`,
);
