import { normalizeYears } from "../server/title/text.ts";
const cases = ["2006 2007 2008", "2006, 2007, 2008", "2006 to 2008", "2006-2008",
  "2006, 2008", "2006-2008; 2010", "2006 2008", "1999 2000 2001 2003",
  "Fits 2006 2007 2008 Ford F-150", "2015-2020", "2006 thru 2008",
  "2006 2007 2008 2010 2011"];
for (const c of cases) {
  console.log(JSON.stringify(c).padEnd(34), "->", JSON.stringify(normalizeYears(c).value));
}
