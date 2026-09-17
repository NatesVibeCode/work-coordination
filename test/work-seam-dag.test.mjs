import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// work-seam.dag.json is the shared vocabulary between this package and the
// harness-handoff contracts, and another repository reads it. It was only
// checked for one thing — that the message note happens to contain each status
// word — which is a substring match, not a contract. A dangling edge or an
// orphan node would have shipped quietly.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dag = JSON.parse(readFileSync(join(root, "work-seam.dag.json"), "utf8"));

test("the seam DAG describes a connected graph", () => {
  const nodes = Object.keys(dag.nodes ?? {});
  assert.ok(nodes.length > 0, "the DAG has nodes");

  // Every edge endpoint must be a declared node.
  for (const [index, edge] of (dag.edges ?? []).entries()) {
    assert.ok(nodes.includes(edge.from), `edge[${index}].from=${edge.from} is not a node`);
    assert.ok(nodes.includes(edge.to), `edge[${index}].to=${edge.to} is not a node`);
    assert.ok(edge.label, `edge[${index}] has no label`);
  }

  // No node may be stranded: the vocabulary has to be reachable from any node.
  const neighbours = new Map(nodes.map((name) => [name, new Set()]));
  for (const edge of dag.edges ?? []) {
    neighbours.get(edge.from).add(edge.to);
    neighbours.get(edge.to).add(edge.from);
  }
  const seen = new Set();
  const frontier = [nodes[0]];
  while (frontier.length) {
    const name = frontier.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of neighbours.get(name)) if (!seen.has(next)) frontier.push(next);
  }
  assert.deepEqual([...seen].sort(), [...nodes].sort(), "no node may be unreachable");
});

test("every seam node is owned and carries what it declares", () => {
  for (const [name, node] of Object.entries(dag.nodes)) {
    assert.ok(node.owner, `${name} has no owner — the seam says who answers for it`);
    assert.ok(
      (node.fields ?? []).length > 0 || node.note,
      `${name} declares neither fields nor a note`,
    );
    assert.ok(
      ["work-coordination", "harness-handoff", "harness-fleet", "host harness", "shared vocabulary"].includes(node.owner),
      `${name} names an owner nobody recognises: ${node.owner}`,
    );
  }
});

test("the declared cross-repo vocabulary matches this package", async () => {
  const { MESSAGE_STATUSES } = await import("../src/coordination.mjs");

  // The message node's note is this package's contract with the rest of the
  // seam: it must name every status the CLI accepts, or a harness reading the
  // seam would refuse a status that works.
  const message = dag.nodes.message;
  assert.ok(message, "the seam declares a message node");
  for (const status of MESSAGE_STATUSES) {
    assert.match(message.note, new RegExp(`\\b${status}\\b`), `the message note omits ${status}`);
  }

  // Fan-out is declared on the edge, not on a node — read it where it lives.
  // `FANOUT_STATUSES` in state.mjs is module-private, so this asserts the seam
  // against the list the CLI documents rather than pretending to import it.
  const fanOutEdge = (dag.edges ?? []).find((edge) => edge.label === "fans_out_to");
  assert.ok(fanOutEdge, "the seam declares which reports fan out");
  assert.match(fanOutEdge.note, /only when status is blocked or done/);
  assert.match(fanOutEdge.note, /failures reported/, "a failed delivery is reported, not fatal");

  // And the seam may not claim control this package does not have.
  const rules = (dag.rules ?? []).join(" ");
  assert.match(rules, /no leases, assignment, lifecycle/, "the no-control rule is the fence");
  assert.match(rules, /nothing waits|never fatal/, "the no-waiting rule is the fence");
});

test("the fluid section does not promise a coordinator", () => {
  // "No manager between sender and lane" is the whole point; a guarantee that
  // mentioned one would contradict it.
  const fluid = dag.fluid ?? {};
  assert.ok(fluid.mode && fluid.guarantee, "the fluid section states its mode and guarantee");
  assert.match(fluid.guarantee, /no coordinator started/, "the guarantee still denies a coordinator");
  for (const intervention of fluid.interventions ?? []) {
    assert.equal(intervention.blocks, false, `${intervention.act} must not block`);
  }
});
