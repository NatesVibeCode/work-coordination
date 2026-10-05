import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { destinationOf, oneLine } from "./coordination.mjs";
import { readJsonFile, reviseJsonFile, StateConflictError } from "./atomic-json.mjs";

export const BUSINESS_CASE_VIEW_SCHEMA = "praxis.business_case_advisory_view.v1";
export const BUSINESS_CASE_RECORD_SCHEMA = "work-coordination.business_case_observation.v1";

const STATE_SCHEMA = "work-coordination.business_case_state.v1";
const STATE_FILE = "business-cases.json";
const MAX_CASES = 512;
const MAX_OUTCOMES = 128;
const MAX_CHOICES = 64;
const MAX_FIELDS = 64;
const MAX_LINE_BYTES = 2048;
const MAX_RENDER_BYTES = 16 << 10;
const MAX_VIEW_BYTES = 64 << 10;
const DISPOSITIONS = new Set(["pending", "accepted", "refused", "unknown", "partial", "superseded"]);

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function boundedLine(value, maxBytes = MAX_LINE_BYTES) {
  const normalized = oneLine(value);
  let output = "";
  for (const character of normalized) {
    const next = output + character;
    if (byteLength(next) > maxBytes) break;
    output = next;
  }
  return output;
}

function boundedBlock(value, maxBytes = MAX_RENDER_BYTES) {
  let output = "";
  for (const character of String(value ?? "")) {
    const next = output + character;
    if (byteLength(next) > maxBytes) break;
    output = next;
  }
  return output;
}

function cleanDisposition(value) {
  const candidate = boundedLine(value, 32).toLowerCase();
  return DISPOSITIONS.has(candidate) ? candidate : "unknown";
}

function textArray(value, limit = MAX_FIELDS, maxBytes = 512) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((item) => boundedLine(item, maxBytes));
}

function cleanProcess(value) {
  return {
    name: boundedLine(value?.name, 256),
    digest: boundedLine(value?.digest, 64),
  };
}

function cleanRequiredOutcome(value) {
  return {
    id: boundedLine(value?.id, 256),
    purpose: boundedLine(value?.purpose, 1024),
    process: cleanProcess(value?.process),
    exposure: boundedLine(value?.exposure, 256),
    contract_digest: boundedLine(value?.contract_digest, 71),
    disposition: cleanDisposition(value?.disposition),
    reported_disposition: cleanDisposition(value?.reported_disposition),
    present: value?.present === true,
    missing: value?.missing === true,
    input_fields: textArray(value?.input_fields),
    input_fields_more: value?.input_fields_more === true,
    invocation_id: boundedLine(value?.invocation_id, 512),
    input_digest: boundedLine(value?.input_digest, 71),
    receipt_ref: boundedLine(value?.receipt_ref, 2048),
    receipt_digest: boundedLine(value?.receipt_digest, 71),
    verification_evidence: textArray(value?.verification_evidence, 32, 1024),
    verification_reason: boundedLine(value?.verification_reason, 1024),
  };
}

function cleanExecutionResult(value) {
  const exitCode = Number.isInteger(value?.exit_code) ? value.exit_code : null;
  const state = boundedLine(value?.execution_state, 32);
  return {
    outcome_id: boundedLine(value?.outcome_id, 256),
    case: { id: boundedLine(value?.case?.id, 256), revision: positiveInteger(value?.case?.revision) },
    process: cleanProcess(value?.process),
    invocation_id: boundedLine(value?.invocation_id, 512),
    input_digest: boundedLine(value?.input_digest, 71),
    execution_state: new Set(["accepted", "queued", "running", "settled", "unknown", "canceled"]).has(state) ? state : "unknown",
    exit_code: exitCode,
    output_digest: boundedLine(value?.output_digest, 71),
    receipt_ref: boundedLine(value?.receipt_ref, 2048),
    receipt_digest: boundedLine(value?.receipt_digest, 71),
    capture_incomplete: value?.capture_incomplete === true,
    handle_ref: boundedLine(value?.handle_ref, 1024),
    binding_status: boundedLine(value?.binding_status, 32) || "unknown",
  };
}

function cleanView(view) {
  if (!view || view.schema !== BUSINESS_CASE_VIEW_SCHEMA) {
    throw new TypeError(`expected SDK view schema ${BUSINESS_CASE_VIEW_SCHEMA}`);
  }
  const id = boundedLine(view.case?.id, 256);
  const revision = positiveInteger(view.case?.revision);
  if (!id || revision === 0) throw new TypeError("SDK case view needs a case id and positive revision");
  if ((view.required_outcomes?.length ?? 0) > MAX_OUTCOMES || (view.execution_results?.length ?? 0) > MAX_OUTCOMES || (view.operator_choices?.length ?? 0) > MAX_CHOICES) {
    throw new RangeError("SDK case view exceeds the advisory projection bounds");
  }
  const normalized = {
    schema: BUSINESS_CASE_VIEW_SCHEMA,
    notice: boundedLine(view.notice, 512),
    case: {
      id,
      revision,
      disposition: cleanDisposition(view.case?.disposition),
      reported_disposition: cleanDisposition(view.case?.reported_disposition),
    },
    outer_facts: {
      work_ref: boundedLine(view.outer_facts?.work_ref, 512),
      input_fields: textArray(view.outer_facts?.input_fields),
      input_fields_more: view.outer_facts?.input_fields_more === true,
    },
    required_outcomes: (Array.isArray(view.required_outcomes) ? view.required_outcomes : []).map(cleanRequiredOutcome),
    missing_outcomes: textArray(view.missing_outcomes, MAX_OUTCOMES, 256),
    execution_results: (Array.isArray(view.execution_results) ? view.execution_results : []).map(cleanExecutionResult),
    operator_choices: (Array.isArray(view.operator_choices) ? view.operator_choices : []).slice(0, MAX_CHOICES).map((choice) => ({
      id: boundedLine(choice?.id, 256),
      selection: boundedLine(choice?.selection, 1024),
      note: boundedLine(choice?.note, 1024),
    })),
  };
  if (byteLength(JSON.stringify(normalized)) > MAX_VIEW_BYTES) {
    throw new RangeError("SDK case view exceeds the stored advisory byte bound");
  }
  return normalized;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function statePath(store) {
  if (!store || typeof store.directory !== "string" || !store.directory) throw new TypeError("a work-coordination store is required");
  return join(store.directory, STATE_FILE);
}

function emptyState() {
  return { schema: STATE_SCHEMA, records: [] };
}

function usableState(value) {
  if (value?.schema !== STATE_SCHEMA || !Array.isArray(value.records)) return emptyState();
  const records = [];
  for (const candidate of value.records.slice(-MAX_CASES)) {
    try { records.push(cleanRecord(candidate)); } catch {}
  }
  return { schema: STATE_SCHEMA, records };
}

export function readBusinessCases(store) {
  const snapshot = usableState(readJsonFile(statePath(store), emptyState()));
  return { schema: snapshot.schema, records: snapshot.records.map(cloneRecord) };
}

// Each call appends an advisory observation. It never replaces another
// participant's view, assigns a writer, or changes Process/effect authority.
export function recordBusinessCase(store, view, { destination = null, now = Date.now(), recordId = randomUUID() } = {}) {
  const normalized = cleanView(view);
  const observedAt = Number(now);
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TypeError("observation time must be a nonnegative integer");
  const id = boundedLine(recordId, 128);
  if (!id) throw new TypeError("record id must be nonempty text");
  const target = destination === null || destination === undefined ? null : canonicalDestination(destination);
  const record = {
    schema: BUSINESS_CASE_RECORD_SCHEMA,
    id,
    case: { id: normalized.case.id, revision: normalized.case.revision },
    disposition: normalized.case.disposition,
    view: normalized,
    destination: target,
    observed_at: observedAt,
    advisory: true,
  };
  reviseJsonFile(statePath(store), emptyState(), (current) => {
    const state = usableState(current);
    if (state.records.some((prior) => prior.id === id)) throw new StateConflictError("business case observation id already exists", { entity: "business_case_observation", id });
    state.records.push(record);
    state.records = state.records.slice(-MAX_CASES);
    return state;
  });
  return cloneRecord(record);
}

export function canonicalDestination(value) {
  const destination = destinationOf(value);
  if (!destination.harness || !destination.sessionRef) throw new TypeError("destination must be <harness>:<session>");
  return { harness: oneLine(destination.harness), session_ref: oneLine(destination.sessionRef) };
}

export function findBusinessCase(store, caseId, revision = null) {
  const wanted = boundedLine(caseId, 256);
  if (!wanted) return null;
  const records = readBusinessCases(store).records.filter((record) => record.case.id === wanted && (revision === null || record.case.revision === positiveInteger(revision)));
  records.sort((a, b) => b.case.revision - a.case.revision || b.observed_at - a.observed_at || b.id.localeCompare(a.id));
  return records.length ? cloneRecord(records[0]) : null;
}

export function renderBusinessCase(record) {
  if (!record || record.schema !== BUSINESS_CASE_RECORD_SCHEMA) return "business case unavailable";
  const view = cleanView(record.view);
  let destination = "unattributed";
  if (record.destination && record.destination.harness && record.destination.session_ref) {
    try {
      const canonical = canonicalDestination(`${oneLine(record.destination.harness)}:${oneLine(record.destination.session_ref)}`);
      destination = `${canonical.harness}:${canonical.session_ref}`;
    } catch {}
  }
  const lines = [
    `Business case · ${oneLine(view.case.id)} · revision ${positiveInteger(view.case.revision)} · disposition ${cleanDisposition(view.case.disposition)}`,
    `advisory · nonexclusive observation · ${destination}`,
  ];
  if (view.notice) lines.push(`notice · ${oneLine(view.notice)}`);
  if (view.outer_facts.work_ref) lines.push(`work · ${oneLine(view.outer_facts.work_ref)}`);
  for (const item of view.required_outcomes) {
    lines.push(`required · ${oneLine(item.id)} · ${cleanDisposition(item.disposition)} · ${oneLine(item.process.name)}@${oneLine(item.process.digest)} · contract ${oneLine(item.contract_digest)}`);
    if (item.missing) lines.push(`contribution · missing · ${oneLine(item.id)}`);
    if (item.invocation_id) lines.push(`contribution · invocation ${oneLine(item.invocation_id)} · receipt ${oneLine(item.receipt_ref)} · ${oneLine(item.receipt_digest)}`);
    if (item.purpose) lines.push(`purpose · ${oneLine(item.purpose)}`);
  }
  for (const id of view.missing_outcomes) lines.push(`missing · ${oneLine(id)}`);
  for (const result of view.execution_results) {
    const exit = result.exit_code === null ? "unknown" : String(result.exit_code);
    lines.push(`execution · ${oneLine(result.outcome_id)} · ${oneLine(result.execution_state)} · exit ${exit} · invocation ${oneLine(result.invocation_id)} · input ${oneLine(result.input_digest)} · output ${oneLine(result.output_digest)} · capture incomplete ${Boolean(result.capture_incomplete)}`);
  }
  for (const choice of view.operator_choices) lines.push(`operator choice · ${oneLine(choice.id)} · ${oneLine(choice.selection)} · ${oneLine(choice.note)}`);
  return boundedBlock(lines.join("\n"), MAX_RENDER_BYTES);
}

export function recordBusinessCaseOp(store, view, options = {}) {
  return renderBusinessCase(recordBusinessCase(store, view, options));
}

export function readBusinessCaseOp(store, caseId, revision = null) {
  const record = findBusinessCase(store, caseId, revision);
  return record ? renderBusinessCase(record) : "no business case observation found";
}

export function listBusinessCasesOp(store) {
  const records = readBusinessCases(store).records;
  if (!records.length) return "no business case observations";
  return boundedBlock(records
    .slice()
    .sort((a, b) => b.observed_at - a.observed_at || a.case.id.localeCompare(b.case.id) || b.case.revision - a.case.revision)
    .map((record) => `${oneLine(record.case.id)} · revision ${record.case.revision} · ${cleanDisposition(record.disposition)} · ${oneLine(record.destination?.harness ?? "unattributed")}:${oneLine(record.destination?.session_ref ?? "unattributed")}`)
    .join("\n"), MAX_RENDER_BYTES);
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function cleanRecord(record) {
  if (record?.schema !== BUSINESS_CASE_RECORD_SCHEMA) throw new TypeError("invalid stored advisory record");
  const view = cleanView(record.view);
  const id = boundedLine(record.id, 128);
  if (!id) throw new TypeError("stored advisory record id is empty");
  let destination = null;
  if (record.destination && typeof record.destination === "object") {
    destination = canonicalDestination(`${oneLine(record.destination.harness)}:${oneLine(record.destination.session_ref)}`);
  }
  const observedAt = Number(record.observed_at);
  return {
    schema: BUSINESS_CASE_RECORD_SCHEMA,
    id,
    case: { id: view.case.id, revision: view.case.revision },
    disposition: view.case.disposition,
    view,
    destination,
    observed_at: Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : 0,
    advisory: true,
  };
}
