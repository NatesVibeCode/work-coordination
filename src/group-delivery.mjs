import { destinationOf } from "./coordination.mjs";
import { deliverMessage, mapBounded } from "./delivery.mjs";

// Each member's delivery has its own idle timeout; they run together so one
// unreachable member cannot add its timeout to every other member's wait.
// Results stay in member order.
export async function deliverGroupMessage(group, message, { deliver, idleTimeoutMs, concurrency = 8 } = {}) {
  const send = deliver ?? ((input) => deliverMessage(input, idleTimeoutMs === undefined ? {} : { idleTimeoutMs }));
  const members = Array.isArray(group?.members) ? group.members : [];
  return mapBounded(members, concurrency, (member) => send({ ...destinationOf(member), message }));
}
