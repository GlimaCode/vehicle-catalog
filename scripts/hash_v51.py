# -*- coding: utf-8 -*-
"""Records SHA-256 hashes for every Version 5.1 release artifact and for the
complete backed-up Version 5.1 application. Run from the project root."""
import csv, hashlib, os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
rows = []


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def add(label, rel):
    full = os.path.join(BASE, rel)
    if os.path.exists(full):
        rows.append({"Artifact": label, "Path": rel, "SHA256": sha256(full),
                     "Bytes": os.path.getsize(full)})
    else:
        rows.append({"Artifact": label, "Path": rel, "SHA256": "", "Bytes": "MISSING"})


add("Version 5.1 release ZIP", "catalog-app/exports/US-Vehicle-Catalog-App-v5.1.zip")
add("Version 5.1 release database", "catalog-app/data/catalog-v5.1.db")
add("Version 5.1 package manifest", "catalog-app/exports/Release_Package_Manifest_v5_1.csv")
add("Version 5.1 final hash manifest", "catalog-app/exports/Version_5_1_Final_Hash_Manifest.csv")
add("Version 5.1 validator", "validate_standardization_workspace_v5_1.py")
add("Version 5 validator", "validate_standardization_workspace_v5.py")
add("Version 5.1 validator report", "catalog-app/data/app_verification_report_v5_1.json")
add("Performance report (JSON)", "catalog-app/exports/Large_File_Performance_Report.json")
add("Backup/restore report", "catalog-app/exports/Backup_Restore_Validation_Report.json")
add("Release database inspection report",
    "catalog-app/exports/Release_Database_Inspection_Report.json")
add("Clean Windows installation report", "catalog-app/Clean_Windows_Installation_Report.md")
add("Version 4 catalog workbook",
    "catalog-app/exports/Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v4.xlsx")
add("Canonical Vehicle Lookup workbook", "catalog-app/exports/Canonical Vehicle Lookup.xlsx")
add("Version 5 release ZIP", "catalog-app/exports/US-Vehicle-Catalog-App-v5.zip")
add("Version 4 release ZIP", "catalog-app/exports/US-Vehicle-Catalog-App-v4.zip")
add("Version 3 release ZIP", "catalog-app/exports/US-Vehicle-Catalog-App-v3.zip")
add("Version 2 release ZIP", "catalog-app/exports/US-Vehicle-Catalog-App-v2.zip")
add("Version 5 database", "catalog-app/data/catalog-v5.db")
add("Version 4 database", "catalog-app/data/catalog-v4.db")
add("Version 3 database", "catalog-app/data/catalog-v3.db")
add("Version 2 database", "catalog-app/data/catalog-v2.db")
add("Version 1 database", "catalog-app/data/catalog.db")

backup = os.path.join(BASE, "catalog-app-phase5-1-backup")
for root, _, files in os.walk(backup):
    for f in sorted(files):
        full = os.path.join(root, f)
        rel = os.path.relpath(full, BASE).replace("\\", "/")
        rows.append({"Artifact": "Version 5.1 application file", "Path": rel,
                     "SHA256": sha256(full), "Bytes": os.path.getsize(full)})

out = os.path.join(BASE, "Phase5_1_Hash_Manifest.csv")
with open(out, "w", newline="", encoding="utf-8-sig") as fh:
    w = csv.DictWriter(fh, ["Artifact", "Path", "SHA256", "Bytes"])
    w.writeheader()
    w.writerows(rows)

missing = [r["Path"] for r in rows if r["Bytes"] == "MISSING"]
print(f"recorded {len(rows)} artifacts -> {out}")
print(f"application files backed up: "
      f"{sum(1 for r in rows if r['Artifact'] == 'Version 5.1 application file')}")
if missing:
    print("MISSING:", missing)
for r in rows[:2]:
    print(f"  {r['Artifact']}: {r['SHA256'][:32]}...")
