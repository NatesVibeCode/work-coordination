import { destinationOf } from "./coordination.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";

// Each member's delivery has its own idle timeout; they run together so one
// unreachable member cannot add its timeout to every other member's wait.
// Results stay in member order. A store passed in travels with each send so
// the visibility policy can refuse a denied member before any transport runs.
export async function deliverGroupMessage(group, message, { deliver, idleTimeoutMs, concurrency = 8, store = null } = {}) {
  const send = deliver ?? ((input) => deliverMessage(input, {
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(store ? { store } : {}),
  }));
  const members = Array.isArray(group?.members) ? group.members : [];
  return mapBounded(members, concurrency, (member) => send({ ...destinationOf(member), message }));
}
