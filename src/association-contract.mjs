import { isDeepStrictEqual } from "node:util";

const BINDING_CONTRACT = "mdview.handoff-binding";
const ASSOCIATION_CONTRACT = "work-coordination.handoff-association";
const SURFACES = new Set(["codex", "opencode", "aoa"]);
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, path, errors) {
  if (!plainObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${path}.${key} is unknown`);
  }
  return true;
}

function singleLine(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && !CONTROL.test(value);
}

function stableId(value) {
  return singleLine(value) && /^[A-Za-z0-9._-]+$/.test(value);
}

function absolutePathLike(value) {
  return singleLine(value) && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value));
}

function relativePath(value) {
  return singleLine(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validTimestamp(value) {
  const match = typeof value === "string"
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
      || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const [zoneHour, zoneMinute] = zone.slice(1).split(":").map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function jsonValue(value) {
  const ancestors = new Set();
  const stack = [{ value, exit: false }];
  while (stack.length) {
    const item = stack.pop();
    const current = item.value;
    if (item.exit) {
      ancestors.delete(current);
      continue;
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) return false;
    if (!Array.isArray(current) && !plainObject(current)) return false;
    ancestors.add(current);
    stack.push({ value: current, exit: true });
    if (Array.isArray(current)) {
      for (const child of current) stack.push({ value: child, exit: false });
    } else {
      for (const child of Object.values(current)) stack.push({ value: child, exit: false });
    }
  }
  return true;
}

function validateBinding(binding, errors, path = "handoffBinding") {
  if (!exactKeys(binding, ["contract", "schemaVersion", "source", "scope"], path, errors)) return;
  if (binding.contract !== BINDING_CONTRACT) errors.push(`${path}.contract must be ${BINDING_CONTRACT}`);
  if (binding.schemaVersion !== 1) errors.push(`${path}.schemaVersion must be 1`);
  if (!singleLine(binding.scope)) errors.push(`${path}.scope must be non-empty single-line text`);
  const sourcePath = `${path}.source`;
  if (!exactKeys(binding.source, [
    "index", "section", "record", "taskId", "taskSha256", "expectedReadSet", "expectedEdition",
  ], sourcePath, errors)) return;
  const source = binding.source;
  if (!absolutePathLike(source.index)) errors.push(`${sourcePath}.index must be an absolute path`);
  if (!stableId(source.section)) errors.push(`${sourcePath}.section must be a stable ID`);
  if (!relativePath(source.record)) errors.push(`${sourcePath}.record must be a safe relative path`);
  if (!stableId(source.taskId)) errors.push(`${sourcePath}.taskId must be a stable ID`);
  if (typeof source.taskSha256 !== "string" || !HASH.test(source.taskSha256)) {
    errors.push(`${sourcePath}.taskSha256 must be a lowercase SHA-256`);
  }
  const readSetPath = `${sourcePath}.expectedReadSet`;
  if (plainObject(source.expectedReadSet)) {
    if (!Object.hasOwn(source.expectedReadSet, "@index")) errors.push(`${readSetPath}.@index is required`);
    for (const [name, digest] of Object.entries(source.expectedReadSet)) {
      if (name !== "@index" && !relativePath(name)) errors.push(`${readSetPath} contains an unsafe source path`);
      if (typeof digest !== "string" || !HASH.test(digest)) errors.push(`${readSetPath}.${name} must be a lowercase SHA-256`);
    }
  } else {
    errors.push(`${readSetPath} must be an object`);
  }
  if (source.expectedEdition !== null
      && (typeof source.expectedEdition !== "string" || !HASH.test(source.expectedEdition))) {
    errors.push(`${sourcePath}.expectedEdition must be a lowercase SHA-256 or null`);
  }
}

export function validateHandoffBinding(binding) {
  const errors = [];
  validateBinding(binding, errors);
  return { valid: errors.length === 0, errors };
}

function identityOf(record) {
  const source = record.handoffBinding.source;
  return JSON.stringify([
    source.index,
    source.section,
    source.record,
    source.taskId,
    record.destination.surface,
    record.destination.sessionId,
    record.attempt.id,
  ]);
}

function sameBindingSource(left, right) {
  return left.contract === right.contract
    && left.schemaVersion === right.schemaVersion
    && isDeepStrictEqual(left.source, right.source);
}

function observationsCompatible(left, right) {
  const byId = new Map(left.observations.map((observation) => [observation.id, observation]));
  return right.observations.every((observation) => {
    const prior = byId.get(observation.id);
    return prior === undefined || isDeepStrictEqual(prior, observation);
  });
}

function validateObservation(observation, index, record, errors, seenIds) {
  const path = `observations[${index}]`;
  if (!exactKeys(observation, ["id", "origin", "observedAt", "nativeKind", "nativeValue"], path, errors)) return;
  if (!stableId(observation.id)) errors.push(`${path}.id must be a stable ID`);
  else if (seenIds.has(observation.id)) errors.push(`${path}.id is duplicated`);
  else seenIds.add(observation.id);
  if (!exactKeys(observation.origin, ["surface", "sessionId", "attemptId"], `${path}.origin`, errors)) return;
  if (observation.origin.surface !== record.destination?.surface
      || observation.origin.sessionId !== record.destination?.sessionId
      || observation.origin.attemptId !== record.attempt?.id) {
    errors.push(`${path}.origin must match the selected surface, session, and attempt`);
  }
  if (!validTimestamp(observation.observedAt)) errors.push(`${path}.observedAt must be an RFC 3339 timestamp`);
  if (!singleLine(observation.nativeKind)) errors.push(`${path}.nativeKind must preserve a non-empty native type`);
  if (!Object.hasOwn(observation, "nativeValue") || !jsonValue(observation.nativeValue)) {
    errors.push(`${path}.nativeValue must be a JSON value`);
  }
}

export function validateHandoffAssociation(record, options = {}) {
  const errors = [];
  if (!plainObject(options)) {
    errors.push("options must be an object");
  } else {
    for (const key of Object.keys(options)) {
      if (key !== "existingRecords") errors.push(`options.${key} is unknown`);
    }
  }
  const existingRecords = plainObject(options) && Object.hasOwn(options, "existingRecords")
    ? options.existingRecords
    : [];
  if (!exactKeys(record, ["contract", "schemaVersion", "handoffBinding", "destination", "attempt", "observations"], "record", errors)) {
    return { valid: false, errors };
  }
  if (record.contract !== ASSOCIATION_CONTRACT) errors.push(`record.contract must be ${ASSOCIATION_CONTRACT}`);
  if (record.schemaVersion !== 1) errors.push("record.schemaVersion must be 1");
  validateBinding(record.handoffBinding, errors);

  if (exactKeys(record.destination, ["selection", "surface", "sessionId"], "destination", errors)) {
    if (record.destination.selection !== "operator-explicit") errors.push("destination.selection must be operator-explicit");
    if (!SURFACES.has(record.destination.surface)) errors.push("destination.surface must be codex, opencode, or aoa");
    if (!singleLine(record.destination.sessionId)) errors.push("destination.sessionId must be an exact non-empty session ID");
  }
  if (exactKeys(record.attempt, ["id"], "attempt", errors)
      && !stableId(record.attempt.id)) errors.push("attempt.id must be a caller-supplied stable ID");

  if (!Array.isArray(record.observations)) {
    errors.push("observations must be an array");
  } else {
    const seenIds = new Set();
    record.observations.forEach((observation, index) => validateObservation(observation, index, record, errors, seenIds));
  }

  if (!Array.isArray(existingRecords)) {
    errors.push("existingRecords must be an array");
  } else if (errors.length === 0) {
    const identity = identityOf(record);
    for (let index = 0; index < existingRecords.length; index += 1) {
      const prior = existingRecords[index];
      const priorResult = validateHandoffAssociation(prior);
      if (!priorResult.valid) {
        errors.push(`existingRecords[${index}] is invalid: ${priorResult.errors.join("; ")}`);
        continue;
      }
      if (identityOf(prior) !== identity) continue;
      const sameDestination = isDeepStrictEqual(prior.destination, record.destination);
      const sameAttempt = isDeepStrictEqual(prior.attempt, record.attempt);
      if (!sameDestination || !sameAttempt || !sameBindingSource(prior.handoffBinding, record.handoffBinding)
          || !observationsCompatible(prior, record) || !observationsCompatible(record, prior)) {
        errors.push(`existingRecords[${index}] conflicts with the same source/session/attempt identity`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function compareHandoffBinding(previous, current) {
  const previousResult = validateHandoffBinding(previous);
  const currentResult = validateHandoffBinding(current);
  const errors = [
    ...previousResult.errors.map((error) => `previous ${error}`),
    ...currentResult.errors.map((error) => `current ${error}`),
  ];
  if (errors.length) return { status: "invalid", changed: [], errors };

  const fields = ["index", "section", "record", "taskId", "taskSha256", "expectedReadSet", "expectedEdition"];
  const changed = fields
    .filter((field) => !isDeepStrictEqual(previous.source[field], current.source[field]))
    .map((field) => `source.${field}`);
  return { status: changed.length ? "stale" : "current", changed, errors: [] };
}
