import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("app contains admin ride control entry points", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /data-action="admin"/);
  assert.match(html, /ride_admin_snapshot/);
  assert.match(html, /ride_admin_publish_plan/);
  assert.match(html, /function adminView/);
  assert.match(html, /function adminEditView/);
});
