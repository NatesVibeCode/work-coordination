import { deliverMessage } from "./delivery.mjs";

function destination(value) {
  const [harness, ...rest] = String(value ?? "").split(":");
  return { harness, sessionRef: rest.join(":") };
}

export async function deliverGroupMessage(group, message, { deliver, idleTimeoutMs } = {}) {
  const send = deliver ?? ((input) => deliverMessage(input, idleTimeoutMs === undefined ? {} : { idleTimeoutMs }));
  const members = Array.isArray(group?.members) ? group.members : [];
  const results = [];
  for (const member of members) {
    results.push(await send({ ...destination(member), message }));
  }
  return results;
}
