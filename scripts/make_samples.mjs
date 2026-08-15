/** Generate the sample CSV/XLSX files shipped with the release. */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "samples");
fs.mkdirSync(dir, { recursive: true });

const rows = [
  ["Item ID", "Title", "Make", "Model", "Trim", "Year", "Drivetrain", "Notes"],
  ["SKU-1001", 'Seat covers for "F150" crew cab', "ford", "F150", "Lariat", "2015-2018", "4WD", "listing A"],
  ["SKU-1002", "Seat covers", "Mercedes Benz", "C-Class", "AMG", "2016", "AWD", ""],
  ["SKU-1003", "Seat covers", "Chevrolet", "Silverado 1500", "LTZ", "2014 2015 2016", "4WD", ""],
  ["SKU-1004", "Seat covers", "Ford", "Excrision", "XLT", "2003-2005", "4WD", "misspelled model"],
  ["SKU-1005", "Seat covers", "Chevrolet", "Escalade", "Platinum", "2012", "AWD", "cross-brand"],
  ["SKU-1006", "Seat covers", "Jaguar", "X Type", "", "2004", "AWD", ""],
  ["SKU-1007", "Seat covers\nmulti-line title", "Toyota", "Tacoma", "SR5", "Fits 2016 to 2018", "4WD", "embedded line break"],
  ["SKU-1008", "Seat covers", "Ford", "F-150", "AWD", "2019", "", "trim column holds a drivetrain value"],
  ["SKU-1009", "Seat covers", "Ram", "1500", "Laramie", "2009", "4WD", "year before Ram brand"],
  ["SKU-1010", "Seat covers", "Nissan", "Frontier", "", "not a year", "", "invalid year format"],
];

const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
fs.writeFileSync(path.join(dir, "sample_vehicle_listings.csv"),
  rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n", "utf-8");

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Listings");
for (const r of rows) ws.addRow(r);
const ws2 = wb.addWorksheet("Notes");
ws2.addRow(["This second worksheet exists so worksheet selection can be demonstrated."]);
await wb.xlsx.writeFile(path.join(dir, "sample_vehicle_listings.xlsx"));
console.log("samples written to", dir);
