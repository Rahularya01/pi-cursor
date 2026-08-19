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
  SwitchModeRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponse_RejectedSchema,
  type InteractionQuery,
  type InteractionResponse,
} from "../proto/agent_pb.js";
import { frameConnectMessage } from "../client/bridge.js";

const CURSOR_WEB_FETCH_INTERACTION_FIELD = 9;

const PI_REJECT_REASON =
  "Not available through the Pi Cursor provider. Use Pi tools (web_search, fetch, bash, etc.) instead.";

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
 * Web/search is rejected by default so Cursor-side fetches do not run under the
 * user's subscription; pass `{ approveWeb: true }` only in tests or explicit opt-in.
 */
export function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
  options?: { approveWeb?: boolean },
): InteractionQueryHandleResult {
  const approveWeb = options?.approveWeb === true;
  const queryCase = query.query.case;

  // Field #9 is unnamed in the generated proto. Approving it is indistinguishable
  // from granting a future destructive capability if Cursor reuses the number.
  if (hasUnknownInteractionField(query, CURSOR_WEB_FETCH_INTERACTION_FIELD)) {
    return {
      handled: false,
      action: "unknown_field_9_rejected",
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
      rejectSwitchMode(query.id, sendFrame);
      return { handled: true, action: "switch_mode_rejected", queryCase };
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
      // Protocol drift must fail closed. An empty result for an unknown field is
      // indistinguishable from approval and could grant a future destructive capability.
      const unknown = (query as unknown as { $unknown?: Array<{ no: number }> }).$unknown ?? [];
      if (unknown.length > 0) {
        const fieldNo = unknown[0]!.no;
        return {
          handled: false,
          action: `unknown_field_${fieldNo}_rejected`,
          queryCase: queryCase ?? "unknown",
        };
      }
      // No case and no unknown fields — still send a switch-mode-style reject is impossible.
      // Best effort: skip ask-question style is wrong. Log as unhandled.
      return { handled: false, action: "unhandled", queryCase: queryCase ?? "undefined" };
    }
  }
}
