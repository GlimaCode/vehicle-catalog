/**
 * Remove validator/test standardization projects from the shipped database,
 * keeping one small demo project. Canonical tables are untouched.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const db = new Database("data/catalog-v5.db");
const before = fs.statSync("data/catalog-v5.db").size / 1024 / 1024;

const keep = db.prepare(`SELECT id FROM standardization_projects
  WHERE row_count <= 100 ORDER BY id DESC LIMIT 1`).get();
const keepId = keep?.id ?? -1;

const doomed = db.prepare("SELECT id FROM standardization_projects WHERE id<>?")
  .all(keepId).map((r) => r.id);
const tx = db.transaction(() => {
  for (const id of doomed) {
    db.prepare("DELETE FROM standardization_changes WHERE project_id=?").run(id);
    db.prepare("DELETE FROM standardization_rows WHERE project_id=?").run(id);
    db.prepare("DELETE FROM project_value_mappings WHERE project_id=?").run(id);
    db.prepare("DELETE FROM project_exports WHERE project_id=?").run(id);
    db.prepare("DELETE FROM standardization_projects WHERE id=?").run(id);
  }
});
tx();
db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");
db.close();

const after = fs.statSync("data/catalog-v5.db").size / 1024 / 1024;
console.log(JSON.stringify({ removedProjects: doomed.length, keptProject: keepId,
  sizeMbBefore: Number(before.toFixed(1)), sizeMbAfter: Number(after.toFixed(1)) }));
