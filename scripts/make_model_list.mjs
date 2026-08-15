/** Simple two-column Make / Model Excel export from the catalog database. */
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new Database(path.join(root, "data", "catalog.db"), { readonly: true });
const rows = db.prepare(`
  SELECT k.standard_make AS make, m.standard_model AS model
  FROM models m JOIN makes k ON k.id = m.make_id
  ORDER BY k.standard_make, m.standard_model`).all();

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Make Model", { views: [{ state: "frozen", ySplit: 1 }] });
ws.columns = [
  { header: "Make", key: "make", width: 22 },
  { header: "Model", key: "model", width: 34 },
];
ws.getRow(1).font = { bold: true };
ws.autoFilter = "A1:B1";
for (const r of rows) ws.addRow([r.make, r.model]);

const out = path.join(root, "exports", "US_Make_Model_List.xlsx");
await wb.xlsx.writeFile(out);
console.log(`rows: ${rows.length}`);
console.log(out);
