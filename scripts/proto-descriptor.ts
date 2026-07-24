/**
 * Reconstructs `proto/agent.proto` from the descriptor embedded in the
 * generated `src/proto/agent_pb.ts`.
 *
 * protoc-gen-es embeds the complete `FileDescriptorProto` (base64) in its
 * output, so the generated file is a lossless carrier for the schema. That
 * makes this the rescue path: when a newer `agent_pb.ts` is obtained from
 * upstream, run `npm run proto:sync` to recover the matching `.proto` source,
 * then `npm run proto:check` to prove the two agree.
 *
 * Only the proto3 subset Cursor's `agent.proto` actually uses is printed
 * (messages, nested types, enums, oneofs, proto3 optional, maps, services).
 * There are no imports, extensions, groups, field defaults, or custom options
 * in this schema; `printProtoFile` throws rather than silently dropping any of
 * them if that ever changes.
 */
import { fromBinary, isFieldSet } from "@bufbuild/protobuf";
import {
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  type ServiceDescriptorProto,
} from "@bufbuild/protobuf/wkt";

const SCALAR_TYPE_NAMES: Record<number, string> = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  12: "bytes",
  13: "uint32",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

/**
 * `oneof_index` is a proto3 optional scalar, so an unset value reads back as 0 —
 * indistinguishable from a genuine index 0. Presence has to be checked explicitly.
 */
function oneofIndexOf(field: FieldDescriptorProto): number | undefined {
  return isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)
    ? field.oneofIndex
    : undefined;
}

const TYPE_GROUP = 10;
const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;
const LABEL_REPEATED = 3;

/** Extracts the base64 `fileDesc(...)` payload from a protoc-gen-es output file. */
export function extractFileDescriptorBytes(generatedSource: string): Uint8Array {
  const match = generatedSource.match(/fileDesc\(\s*"([A-Za-z0-9+/=]+)"/);
  if (!match) {
    throw new Error("no fileDesc(...) literal found — is this a protoc-gen-es generated file?");
  }
  return new Uint8Array(Buffer.from(match[1]!, "base64"));
}

export function parseFileDescriptor(generatedSource: string): FileDescriptorProto {
  return fromBinary(FileDescriptorProtoSchema, extractFileDescriptorBytes(generatedSource));
}

/** Strips the leading `.pkg.` so nested/sibling references print unqualified. */
function typeName(fullName: string, pkg: string): string {
  const bare = fullName.replace(/^\./, "");
  const prefix = `${pkg}.`;
  return bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
}

function fieldTypeName(field: FieldDescriptorProto, pkg: string): string {
  if (field.type === TYPE_MESSAGE || field.type === TYPE_ENUM) {
    return typeName(field.typeName, pkg);
  }
  const scalar = SCALAR_TYPE_NAMES[field.type];
  if (!scalar) throw new Error(`unsupported field type ${field.type} on ${field.name}`);
  return scalar;
}

/** Map fields are a repeated message whose type is a synthetic `map_entry`. */
function mapEntryFor(
  field: FieldDescriptorProto,
  message: DescriptorProto,
  pkg: string,
): DescriptorProto | undefined {
  if (field.label !== LABEL_REPEATED || field.type !== TYPE_MESSAGE) return undefined;
  const local = typeName(field.typeName, pkg).split(".").pop();
  const nested = message.nestedType.find((n) => n.name === local);
  return nested?.options?.mapEntry ? nested : undefined;
}

function printField(
  field: FieldDescriptorProto,
  message: DescriptorProto,
  pkg: string,
  indent: string,
): string {
  if (field.type === TYPE_GROUP) throw new Error(`groups are not supported (${field.name})`);
  if (field.defaultValue) throw new Error(`field defaults are not supported (${field.name})`);
  if (field.extendee) throw new Error(`extensions are not supported (${field.name})`);

  const entry = mapEntryFor(field, message, pkg);
  if (entry) {
    const key = entry.field.find((f) => f.number === 1)!;
    const value = entry.field.find((f) => f.number === 2)!;
    const k = fieldTypeName(key, pkg);
    const v = fieldTypeName(value, pkg);
    return `${indent}map<${k}, ${v}> ${field.name} = ${field.number};`;
  }

  let prefix = "";
  if (field.proto3Optional) prefix = "optional ";
  else if (field.label === LABEL_REPEATED) prefix = "repeated ";

  return `${indent}${prefix}${fieldTypeName(field, pkg)} ${field.name} = ${field.number};`;
}

function printReserved(
  ranges: Array<{ start: number; end: number }>,
  names: string[],
  indent: string,
  out: string[],
): void {
  for (const range of ranges) {
    // Descriptor ranges are half-open; proto text is inclusive.
    const last = range.end - 1;
    const span = range.start === last ? `${range.start}` : `${range.start} to ${last}`;
    out.push(`${indent}reserved ${span};`);
  }
  if (names.length > 0) {
    out.push(`${indent}reserved ${names.map((n) => `"${n}"`).join(", ")};`);
  }
}

function printEnum(desc: EnumDescriptorProto, indent: string, out: string[]): void {
  out.push(`${indent}enum ${desc.name} {`);
  const inner = `${indent}  `;
  if (desc.options?.allowAlias) out.push(`${inner}option allow_alias = true;`);
  printReserved(
    desc.reservedRange.map((r) => ({ start: r.start, end: r.end + 1 })),
    desc.reservedName,
    inner,
    out,
  );
  for (const value of desc.value) {
    out.push(`${inner}${value.name} = ${value.number};`);
  }
  out.push(`${indent}}`);
}

function printMessage(desc: DescriptorProto, pkg: string, indent: string, out: string[]): void {
  if (desc.options?.mapEntry) return; // emitted inline as map<k, v>
  if (desc.extension.length > 0) throw new Error(`extensions are not supported (${desc.name})`);

  out.push(`${indent}message ${desc.name} {`);
  const inner = `${indent}  `;

  printReserved(desc.reservedRange, desc.reservedName, inner, out);

  // Fields in declaration order, with real oneofs emitted at the position of
  // their first member. Synthetic oneofs (proto3 optional) are skipped.
  const emittedOneofs = new Set<number>();
  const syntheticOneofs = new Set(
    desc.field.filter((f) => f.proto3Optional).map((f) => oneofIndexOf(f)!),
  );

  for (const field of desc.field) {
    const oneofIndex = oneofIndexOf(field);
    const inRealOneof =
      oneofIndex !== undefined && !field.proto3Optional && !syntheticOneofs.has(oneofIndex);

    if (!inRealOneof) {
      out.push(printField(field, desc, pkg, inner));
      continue;
    }
    if (emittedOneofs.has(oneofIndex)) continue;
    emittedOneofs.add(oneofIndex);

    out.push(`${inner}oneof ${desc.oneofDecl[oneofIndex]!.name} {`);
    for (const member of desc.field) {
      if (oneofIndexOf(member) === oneofIndex && !member.proto3Optional) {
        out.push(printField(member, desc, pkg, `${inner}  `));
      }
    }
    out.push(`${inner}}`);
  }

  for (const nested of desc.nestedType) printMessage(nested, pkg, inner, out);
  for (const nested of desc.enumType) printEnum(nested, inner, out);

  out.push(`${indent}}`);
}

function printService(desc: ServiceDescriptorProto, pkg: string, out: string[]): void {
  out.push(`service ${desc.name} {`);
  for (const method of desc.method) {
    const input = `${method.clientStreaming ? "stream " : ""}${typeName(method.inputType, pkg)}`;
    const output = `${method.serverStreaming ? "stream " : ""}${typeName(method.outputType, pkg)}`;
    // Note the trailing `;` rather than `{}` — an empty body would materialize an
    // empty MethodOptions in the descriptor and diverge from upstream.
    out.push(`  rpc ${method.name}(${input}) returns (${output});`);
  }
  out.push("}");
}

export function printProtoFile(fd: FileDescriptorProto): string {
  if (fd.syntax && fd.syntax !== "proto3") {
    throw new Error(`only proto3 is supported, got ${fd.syntax}`);
  }
  if (fd.dependency.length > 0) throw new Error(`imports are not supported: ${fd.dependency}`);
  if (fd.extension.length > 0) throw new Error("file-level extensions are not supported");

  const pkg = fd.package;
  const out: string[] = [
    "// Cursor agent wire schema (package agent.v1).",
    "//",
    "// Reverse-engineered from Cursor's client; reconstructed from the descriptor",
    "// embedded in a protoc-gen-es build via `npm run proto:sync`. This file is the",
    "// source of truth for `src/proto/agent_pb.ts` — regenerate with `npm run proto:gen`.",
    "",
    'syntax = "proto3";',
    "",
    `package ${pkg};`,
    "",
  ];

  for (const message of fd.messageType) {
    printMessage(message, pkg, "", out);
    out.push("");
  }
  for (const enumType of fd.enumType) {
    printEnum(enumType, "", out);
    out.push("");
  }
  for (const service of fd.service) {
    printService(service, pkg, out);
    out.push("");
  }

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
