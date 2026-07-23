/**
 * Handle Cursor InteractionQuery messages so the AgentService stream never
 * stalls waiting for a permission / interaction reply that Pi never sends.
 *
 * Unanswered interaction queries are a primary cause of "model stops after a
 * few minutes" — Cursor parks the run until InteractionResponse arrives.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AskQuestionErrorSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionResultSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  ExaFetchRequestResponseSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponse_RejectedSchema,
  InteractionResponseSchema,
  SetupVmEnvironmentResultSchema,
  SetupVmEnvironmentSuccessSchema,
  SwitchModeRequestResponseSchema,
  SwitchModeRequestResponse_ApprovedSchema,
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponse_RejectedSchema,
  type InteractionQuery,
  type InteractionResponse,
} from "../proto/agent_pb.js";
import { frameConnectMessage } from "../client/bridge.js";

const CURSOR_WEB_FETCH_INTERACTION_FIELD = 9;
const CURSOR_WEB_FETCH_APPROVED_RESPONSE = new Uint8Array([0x0a, 0x00]);

const PI_REJECT_REASON =
  "Not available through the Pi Cursor provider. Use Pi tools (web_search, fetch, bash, etc.) instead.";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return bytes;
}

function encodeLengthDelimitedField(fieldNo: number, data: Uint8Array): number[] {
  return [(fieldNo << 3) | 2, ...encodeVarint(data.length), ...data];
}

function buildCursorWebFetchInteractionApprovalBytes(id: number): Uint8Array {
  // Field #9 is not yet named in the generated proto; approve via raw wire bytes.
  const interactionResponse = new Uint8Array([
    0x08,
    ...encodeVarint(id),
    ...encodeLengthDelimitedField(
      CURSOR_WEB_FETCH_INTERACTION_FIELD,
      CURSOR_WEB_FETCH_APPROVED_RESPONSE,
    ),
  ]);
  return new Uint8Array(encodeLengthDelimitedField(6, interactionResponse));
}

function hasUnknownInteractionField(query: InteractionQuery, fieldNo: number): boolean {
  return ((query as unknown as { $unknown?: Array<{ no: number }> }).$unknown ?? []).some(
    (field) => field.no === fieldNo,
  );
}

function sendInteractionResponse(
  response: InteractionResponse,
  sendFrame: (data: Uint8Array) => void,
): void {
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

function approveWebSearch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: {
            case: "approved",
            value: create(WebSearchRequestResponse_ApprovedSchema, {}),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function rejectWebSearch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(WebSearchRequestResponse_RejectedSchema, { reason: PI_REJECT_REASON }),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function approveExaSearch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: {
            case: "approved",
            value: create(ExaSearchRequestResponse_ApprovedSchema, {}),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function rejectExaSearch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(ExaSearchRequestResponse_RejectedSchema, { reason: PI_REJECT_REASON }),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function approveExaFetch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: {
            case: "approved",
            value: create(ExaFetchRequestResponse_ApprovedSchema, {}),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function rejectExaFetch(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(ExaFetchRequestResponse_RejectedSchema, { reason: PI_REJECT_REASON }),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function approveSwitchMode(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: "approved",
            value: create(SwitchModeRequestResponse_ApprovedSchema, {}),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function rejectSwitchMode(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(SwitchModeRequestResponse_RejectedSchema, { reason: PI_REJECT_REASON }),
          },
        }),
      },
    }),
    sendFrame,
  );
}

function skipAskQuestion(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: {
              case: "error",
              value: create(AskQuestionErrorSchema, {
                errorMessage:
                  "Interactive questions are not available in Pi. Continue with a reasonable default or ask the user in chat.",
              }),
            },
          }),
        }),
      },
    }),
    sendFrame,
  );
}

function skipCreatePlan(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            planUri: "",
            result: {
              case: "error",
              value: create(CreatePlanErrorSchema, {
                error: "Create-plan UI is not available in Pi. Write the plan with Pi file tools.",
              }),
            },
          }),
        }),
      },
    }),
    sendFrame,
  );
}

function skipSetupVm(id: number, sendFrame: (data: Uint8Array) => void): void {
  sendInteractionResponse(
    create(InteractionResponseSchema, {
      id,
      result: {
        case: "setupVmEnvironmentResult",
        value: create(SetupVmEnvironmentResultSchema, {
          result: {
            case: "success",
            value: create(SetupVmEnvironmentSuccessSchema, {}),
          },
        }),
      },
    }),
    sendFrame,
  );
}

export type InteractionQueryHandleResult = {
  handled: boolean;
  action: string;
  queryCase: string | undefined;
};

/**
 * Always attempt to answer InteractionQuery so the upstream run does not park.
 * Prefer approving read-only web/search modes; skip interactive UI flows.
 */
export function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
  options?: { approveWeb?: boolean },
): InteractionQueryHandleResult {
  const approveWeb = options?.approveWeb !== false;
  const queryCase = query.query.case;

  // Unnamed WebFetch permission (proto field 9).
  if (hasUnknownInteractionField(query, CURSOR_WEB_FETCH_INTERACTION_FIELD)) {
    sendFrame(frameConnectMessage(buildCursorWebFetchInteractionApprovalBytes(query.id)));
    return {
      handled: true,
      action: "web_fetch_approved",
      queryCase: queryCase ?? "unknown_field_9",
    };
  }

  switch (queryCase) {
    case "webSearchRequestQuery":
      if (approveWeb) approveWebSearch(query.id, sendFrame);
      else rejectWebSearch(query.id, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "web_search_approved" : "web_search_rejected",
        queryCase,
      };
    case "exaSearchRequestQuery":
      if (approveWeb) approveExaSearch(query.id, sendFrame);
      else rejectExaSearch(query.id, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "exa_search_approved" : "exa_search_rejected",
        queryCase,
      };
    case "exaFetchRequestQuery":
      if (approveWeb) approveExaFetch(query.id, sendFrame);
      else rejectExaFetch(query.id, sendFrame);
      return {
        handled: true,
        action: approveWeb ? "exa_fetch_approved" : "exa_fetch_rejected",
        queryCase,
      };
    case "switchModeRequestQuery":
      // Approving mode switches keeps the agent moving; reject if you want strict agent mode only.
      approveSwitchMode(query.id, sendFrame);
      return { handled: true, action: "switch_mode_approved", queryCase };
    case "askQuestionInteractionQuery":
      skipAskQuestion(query.id, sendFrame);
      return { handled: true, action: "ask_question_skipped", queryCase };
    case "createPlanRequestQuery":
      skipCreatePlan(query.id, sendFrame);
      return { handled: true, action: "create_plan_skipped", queryCase };
    case "setupVmEnvironmentArgs":
      skipSetupVm(query.id, sendFrame);
      return { handled: true, action: "setup_vm_acked", queryCase };
    default: {
      // Last-resort: if Cursor added a new named field we don't know, try web-fetch-style
      // empty approve on any unknown field so we never leave the stream parked.
      const unknown = (query as unknown as { $unknown?: Array<{ no: number }> }).$unknown ?? [];
      if (unknown.length > 0) {
        const fieldNo = unknown[0]!.no;
        const emptyApproved = new Uint8Array([0x0a, 0x00]);
        const interactionResponse = new Uint8Array([
          0x08,
          ...encodeVarint(query.id),
          ...encodeLengthDelimitedField(fieldNo, emptyApproved),
        ]);
        const frame = new Uint8Array(encodeLengthDelimitedField(6, interactionResponse));
        sendFrame(frameConnectMessage(frame));
        return {
          handled: true,
          action: `unknown_field_${fieldNo}_approved`,
          queryCase: queryCase ?? "unknown",
        };
      }
      // No case and no unknown fields — still send a switch-mode-style reject is impossible.
      // Best effort: skip ask-question style is wrong. Log as unhandled.
      return { handled: false, action: "unhandled", queryCase: queryCase ?? "undefined" };
    }
  }
}

// Keep reject helpers referenced for future strict mode.
void rejectSwitchMode;
