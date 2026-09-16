import { deliverMessage } from "./delivery.mjs";

function destination(value) {
  const [harness, ...rest] = String(value ?? "").split(":");
  return { harness, sessionRef: rest.join(":") };
}

export function deliverGroupMessage(group, message, { deliver = deliverMessage } = {}) {
  const members = Array.isArray(group?.members) ? group.members : [];
  return members.map((member) => deliver({ ...destination(member), message }));
}
