export interface CursorModelParameter {
  id: string;
  value: string;
}

export interface CursorParameterizedVariant {
  parameters: CursorModelParameter[];
  isMaxMode: boolean;
  isDefaultMaxConfig?: boolean;
  isDefaultNonMaxConfig?: boolean;
  displayName?: string;
  displayNameOutsidePicker?: string;
  variantStringRepresentation?: string;
}

export interface CursorParameterizedModel {
  name: string;
  clientDisplayName?: string;
  serverModelName?: string;
  supportsMaxMode?: boolean;
  supportsNonMaxMode?: boolean;
  supportsImages?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  variants: CursorParameterizedVariant[];
}

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function encodeBoolField(fieldNo: number, value: boolean): number[] {
  return [...encodeVarint(fieldNo << 3), value ? 1 : 0];
}

export function encodeAvailableModelsRequest(): Uint8Array {
  // aiserver.v1.AvailableModelsRequest {
  //   optional bool use_model_parameters = 5;
  //   optional bool do_not_use_markdown = 7;
  // }
  return new Uint8Array([...encodeBoolField(5, true), ...encodeBoolField(7, true)]);
}

interface WireReader {
  bytes: Uint8Array;
  offset: number;
}

function readVarint(reader: WireReader): number {
  let result = 0;
  let shift = 0;
  while (reader.offset < reader.bytes.length) {
    const byte = reader.bytes[reader.offset++]!;
    // Avoid JS bitwise operators here: they truncate to 32 bits, but protobuf
    // varints can legally carry 64-bit values on fields we merely skip.
    if (shift < 53) result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift >= 70) throw new Error("varint too long");
  }
  throw new Error("unexpected EOF while reading varint");
}

function readLengthDelimited(reader: WireReader): Uint8Array {
  const length = readVarint(reader);
  if (!Number.isSafeInteger(length)) throw new Error("length-delimited size is too large");
  const end = reader.offset + length;
  if (end > reader.bytes.length) throw new Error("length-delimited field exceeds buffer");
  const value = reader.bytes.subarray(reader.offset, end);
  reader.offset = end;
  return value;
}

function skipBytes(reader: WireReader, length: number): void {
  const end = reader.offset + length;
  if (end > reader.bytes.length) throw new Error("fixed-width field exceeds buffer");
  reader.offset = end;
}

function skipWireField(reader: WireReader, wireType: number): void {
  switch (wireType) {
    case 0:
      readVarint(reader);
      return;
    case 1:
      skipBytes(reader, 8);
      return;
    case 2:
      readLengthDelimited(reader);
      return;
    case 5:
      skipBytes(reader, 4);
      return;
    default:
      throw new Error(`unsupported wire type ${wireType}`);
  }
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeModelParameter(bytes: Uint8Array): CursorModelParameter {
  const reader: WireReader = { bytes, offset: 0 };
  const parameter: CursorModelParameter = { id: "", value: "" };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 1 && wireType === 2) parameter.id = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 2 && wireType === 2)
      parameter.value = decodeString(readLengthDelimited(reader));
    else skipWireField(reader, wireType);
  }
  return parameter;
}

function decodeParameterizedVariant(bytes: Uint8Array): CursorParameterizedVariant {
  const reader: WireReader = { bytes, offset: 0 };
  const variant: CursorParameterizedVariant = { parameters: [], isMaxMode: false };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 1 && wireType === 2)
      variant.parameters.push(decodeModelParameter(readLengthDelimited(reader)));
    else if (fieldNo === 2 && wireType === 2)
      variant.displayName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 8 && wireType === 2)
      variant.displayNameOutsidePicker = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 3 && wireType === 0) variant.isMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 4 && wireType === 0) variant.isDefaultMaxConfig = readVarint(reader) !== 0;
    else if (fieldNo === 5 && wireType === 0)
      variant.isDefaultNonMaxConfig = readVarint(reader) !== 0;
    else if (fieldNo === 9 && wireType === 2)
      variant.variantStringRepresentation = decodeString(readLengthDelimited(reader));
    else skipWireField(reader, wireType);
  }
  return variant;
}

function decodeParameterizedModel(bytes: Uint8Array): CursorParameterizedModel {
  const reader: WireReader = { bytes, offset: 0 };
  const model: CursorParameterizedModel = { name: "", variants: [] };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 1 && wireType === 2) model.name = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 10 && wireType === 0) model.supportsImages = readVarint(reader) !== 0;
    else if (fieldNo === 14 && wireType === 0) model.supportsMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 19 && wireType === 0) model.supportsNonMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 15 && wireType === 0) model.contextTokenLimit = readVarint(reader);
    else if (fieldNo === 16 && wireType === 0)
      model.contextTokenLimitForMaxMode = readVarint(reader);
    else if (fieldNo === 17 && wireType === 2)
      model.clientDisplayName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 18 && wireType === 2)
      model.serverModelName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 30 && wireType === 2)
      model.variants.push(decodeParameterizedVariant(readLengthDelimited(reader)));
    else skipWireField(reader, wireType);
  }
  return model;
}

export function decodeAvailableModelsResponse(bytes: Uint8Array): CursorParameterizedModel[] {
  const reader: WireReader = { bytes, offset: 0 };
  const models: CursorParameterizedModel[] = [];
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNo === 2 && wireType === 2) {
      const model = decodeParameterizedModel(readLengthDelimited(reader));
      if (model.name) models.push(model);
    } else {
      skipWireField(reader, wireType);
    }
  }
  return models;
}

// No generated schema for selectedContextBlob; emit raw wire format for the two
// fields Cursor actually reads: field 1 (repeated bytes) rootPromptMessagesJson
// refs, field 22 (string) clientName. blobId.length < 128 (SHA256 = 32 bytes).
export function buildSelectedContextBlob(
  rootPromptBlobIds: Uint8Array[],
  clientName: string,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const blobId of rootPromptBlobIds) {
    parts.push(new Uint8Array([0x0a, blobId.length, ...blobId]));
  }
  const clientBytes = new TextEncoder().encode(clientName);
  parts.push(new Uint8Array([0xb2, 0x01, clientBytes.length, ...clientBytes]));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}
