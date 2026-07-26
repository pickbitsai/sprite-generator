import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("loop.manifest.json", "utf8"));

test("loop manifest uses unique nodes and connected edges", () => {
  const ids = manifest.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const edge of manifest.edges) {
    assert.ok(ids.includes(edge.from), `unknown edge source: ${edge.from}`);
    assert.ok(ids.includes(edge.to), `unknown edge target: ${edge.to}`);
    assert.ok(edge.when);
  }
});

test("loop manifest records authority, stops, and sabotage evidence", () => {
  assert.ok(manifest.authority.model_may_not.length);
  assert.ok(manifest.stop_conditions.length >= 5);
  assert.ok(manifest.gates.length >= 3);
  for (const gate of manifest.gates) {
    assert.ok(gate.accepts);
    assert.ok(gate.rejects);
    assert.ok(gate.evidence.length);
  }
});
