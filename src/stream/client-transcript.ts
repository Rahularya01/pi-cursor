/**
 * Client transcript identity for one Cursor turn.
 *
 * Two histories exist while a turn runs and they are not the same thing:
 *
 * - the **wire history** (`completedTurns` + `currentTurn`) is what we send upstream. Recovery
 *   rewrites it: a full-history rebuild folds the in-flight turn into completed history, and a
 *   checkpoint continuation replaces the current turn with a synthetic one.
 * - the **client transcript** is what pi will send us on the next request. Recovery never changes
 *   it, because pi never saw the recovery.
 *
 * Every staleness and recovery decision belongs to the client transcript: mid-pause snapshots,
 * checkpoint metadata, bridge-collision fingerprints, and the in-flight turn `planRecovery`
 * matches tool results against. Recording wire history there instead is what made a bridge loss
 * after any earlier recovery unrecoverable — the wire turn is only a suffix of pi's turn, so exact
 * tool-id matching could never succeed again for the rest of the session.
 */
import type { ClientTranscript, ParsedTurn } from "./types.js";

export type { ClientTranscript } from "./types.js";

export function liveTranscript(completedTurns: ParsedTurn[]): ClientTranscript {
  return { kind: "live", completedTurns };
}

export function recoveredTranscript(
  completedTurns: ParsedTurn[],
  inFlightTurn: ParsedTurn,
): ClientTranscript {
  return { kind: "recovered", completedTurns, inFlightTurn };
}

/**
 * The turn pi will report as completed once this stream finishes.
 *
 * `live` means the wire current turn *is* pi's in-flight turn, so it stands alone. `recovered`
 * means the wire turn is synthetic and only carries the steps produced since recovery, so pi's
 * turn is the recorded one extended by those steps. The synthetic turn's user text is a recovery
 * wrapper pi never sent and is deliberately dropped.
 */
export function clientInFlightTurn(
  transcript: ClientTranscript,
  wireCurrentTurn: ParsedTurn,
): ParsedTurn {
  if (transcript.kind === "live") return wireCurrentTurn;
  const base = transcript.inFlightTurn;
  return { ...base, steps: [...base.steps, ...wireCurrentTurn.steps] };
}

/** Completed history from pi's point of view once this stream finishes. */
export function clientCompletedHistory(
  transcript: ClientTranscript,
  wireCurrentTurn: ParsedTurn,
): ParsedTurn[] {
  return [...transcript.completedTurns, clientInFlightTurn(transcript, wireCurrentTurn)];
}

/**
 * Fold a synthetic wire turn into the transcript.
 *
 * Called wherever recovery replaces the wire current turn, so steps that turn already produced
 * stay attributed to pi's in-flight turn instead of being forgotten.
 */
export function withSyntheticCurrentTurn(
  transcript: ClientTranscript,
  wireCurrentTurn: ParsedTurn,
): ClientTranscript {
  return recoveredTranscript(
    transcript.completedTurns,
    clientInFlightTurn(transcript, wireCurrentTurn),
  );
}
