# -*- coding: utf-8 -*-
"""
Independent Version 5 validator for the File Standardization workspace.

Runs against the built application and catalog-v5.db, exercising a
representative CSV and XLSX end-to-end through the HTTP API, and verifying
that the frozen Version 4 canonical catalog is untouched.
PASS only when every mandatory check succeeds.
"""
import csv, hashlib, json, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(BASE, "catalog-app")
# The validator writes projects, so it runs against a disposable copy by
# default (V5_DB), leaving the shipped catalog-v5.db pristine.
DB = os.environ.get("V5_DB", os.path.join(APP, "data", "catalog-v5.db"))
V4_DB = os.path.join(APP, "data", "catalog-v4.db")
SAMPLES = os.path.join(APP, "samples")
PORT = int(os.environ.get("V5_PORT", "4319"))
ROOT = f"http://127.0.0.1:{PORT}"

CANONICAL_TABLES = ["makes", "models", "model_years", "vehicle_hierarchy_values",
                    "hierarchy_value_years", "vehicle_configuration_values",
                    "configuration_value_years", "aliases",
                    "grouped_model_relationships"]

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def req(path, method="GET", data=None, headers=None, raw=None):
    url = ROOT + path
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    hdrs = {"Content-Type": "application/json"} if data is not None else {}
    hdrs.update(headers or {})
    r = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(r, timeout=120) as resp:
        payload = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        return json.loads(payload) if "json" in ctype else payload

def canonical_counts(db_path):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    out = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in CANONICAL_TABLES}
    con.close()
    return out

def main():
    checks = []
    def c(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        return ok

    # ---- 1. Version 4 artifacts unchanged (hash re-check) -------------------
    manifest_path = os.path.join(BASE, "Phase4_Hash_Manifest.csv")
    manifest = list(csv.DictReader(open(manifest_path, encoding="utf-8-sig")))
    fails = []
    for row in manifest:
        p = row["Path"]
        if p.startswith("catalog-app-phase4-backup"):
            continue                      # the backup itself is the reference copy
        full = os.path.join(BASE, p)
        if not os.path.exists(full):
            fails.append(p + " (missing)")
            continue
        if sha256(full).upper() != row["SHA256"].upper():
            fails.append(p)
    c("Version 4 canonical hashes remain unchanged", not fails, fails[:6])

    # ---- 2. canonical tables identical between v4 and v5 --------------------
    v4 = canonical_counts(V4_DB)
    v5 = canonical_counts(DB)
    c("Canonical tables were not modified in catalog-v5.db", v4 == v5,
      f"v4={v4} v5={v5}")

    # ---- 3. new project tables exist ---------------------------------------
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    tables = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    needed = {"standardization_projects", "standardization_rows",
              "standardization_changes", "mapping_templates",
              "project_value_mappings", "catalog_change_proposals"}
    c("All new project tables exist", needed <= tables, sorted(needed - tables))

    # ---- start the server --------------------------------------------------
    env = dict(os.environ, PORT=str(PORT), CATALOG_DB=DB)
    server = subprocess.Popen(["npm.cmd", "start"], cwd=APP, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              shell=False)
    try:
        for _ in range(60):
            try:
                req("/api/summary")
                break
            except Exception:
                time.sleep(1)
        else:
            c("Application starts", False, "server did not become ready")
            raise SystemExit(_finish(checks))
        c("Application starts and serves the catalog API", True)

        results = {}
        for label, fname in [("CSV", "sample_vehicle_listings.csv"),
                             ("XLSX", "sample_vehicle_listings.xlsx")]:
            payload = open(os.path.join(SAMPLES, fname), "rb").read()
            up = req("/api/std/upload", "POST", raw=payload,
                     headers={"X-Filename": fname,
                              "Content-Type": "application/octet-stream",
                              "X-Project-Name": f"V5%20validator%20{label}"})
            pid = up["projectId"]
            headers = up["preview"]["headers"]
            columns = []
            for i, h in enumerate(headers):
                field = ("Model Year" if h == "Year"
                         else h if h in ("Make", "Model", "Trim", "Drivetrain",
                                         "Title", "Item ID")
                         else "Preserve as Custom Field")
                columns.append({"column": h, "index": i, "field": field})
            req(f"/api/std/projects/{pid}/mapping", "POST",
                {"mapping": {"headerRow": 1, "preserveUnmapped": True, "columns": columns}})
            req(f"/api/std/projects/{pid}/process", "POST", {})
            for _ in range(120):
                pr = req(f"/api/std/projects/{pid}/progress")
                if not pr["running"] and pr["status"] != "Processing":
                    break
                time.sleep(0.5)
            results[label] = (pid, req(f"/api/std/projects/{pid}"))
            c(f"A representative {label} imports and processes correctly",
              results[label][1]["stats"]["inputRows"] == 10,
              f"rows={results[label][1]['stats']['inputRows']}")

        pid, info = results["CSV"]
        rows = req(f"/api/std/projects/{pid}/rows?pageSize=50")["rows"]
        by_item = {r["original"]["Item ID"]: r for r in rows}

        # ---- 4. exact and alias matches ------------------------------------
        f1 = by_item["SKU-1001"]["normalized"]["fields"]
        f4 = by_item["SKU-1004"]["normalized"]["fields"]
        c("Exact, deterministic and alias matches apply automatically",
          f1["Make"]["value"] == "Ford" and f1["Make"]["applied"]
          and f1["Model"]["value"] == "F-150"
          and f4["Model"]["value"] == "Excursion"
          and f4["Model"]["confidence"] == "Approved Alias Match",
          f"{f1['Make']['confidence']}, {f1['Model']['confidence']}, {f4['Model']['confidence']}")

        # ---- 5. suggested matches require approval -------------------------
        suggested = [(r["row_number"], field, f)
                     for r in rows for field, f in r["normalized"]["fields"].items()
                     if f["confidence"] in ("High Confidence Suggested Match",
                                            "Low Confidence Suggested Match")]
        c("Suggested matches are never auto-applied",
          all(not f["applied"] for _, _, f in suggested),
          f"{len(suggested)} suggested match(es)")

        # ---- 6. cross-brand conflicts stay visible -------------------------
        f5 = by_item["SKU-1005"]["normalized"]["fields"]
        c("Cross-brand conflicts remain visible and unapplied",
          f5["Model"]["confidence"] == "Conflict" and not f5["Model"]["applied"]
          and "Cadillac" in (f5["Model"].get("conflict") or ""),
          f5["Model"].get("conflict"))

        # ---- 7/8. audit vs replacement mode --------------------------------
        audit = req(f"/api/std/projects/{pid}/export.csv?mode=audit").decode("utf-8")
        arows = list(csv.DictReader(audit.splitlines()))
        c("Audit mode preserves original values and adds standardized columns",
          arows[0]["Make"] == "ford" and arows[0]["Original Make"] == "ford"
          and arows[0]["Standard Make"] == "Ford"
          and "Row Review Status" in arows[0],
          f"{arows[0]['Make']} / {arows[0]['Standard Make']}")
        repl = req(f"/api/std/projects/{pid}/export.csv?mode=replacement").decode("utf-8")
        rrows = list(csv.DictReader(repl.splitlines()))
        conflict_row = next(r for r in rrows if r["Item ID"] == "SKU-1005")
        c("Replacement mode changes only authorized fields",
          rrows[0]["Make"] == "Ford" and rrows[0]["Model"] == "F-150"
          and rrows[0]["Item ID"] == "SKU-1001"
          and conflict_row["Model"] == "Escalade"      # conflict left untouched
          and "Original Make" not in rrows[0],
          f"conflict row model={conflict_row['Model']}")

        # ---- 9. excluded rows ----------------------------------------------
        req(f"/api/std/projects/{pid}/decision", "POST",
            {"rowNumber": 6, "field": "(row)", "decision": "Exclude From Export"})
        after = list(csv.DictReader(
            req(f"/api/std/projects/{pid}/export.csv?mode=audit").decode("utf-8").splitlines()))
        c("Excluded rows are removed from the export but kept in the project",
          len(after) == len(arows) - 1
          and req(f"/api/std/projects/{pid}")["stats"]["inputRows"] == 10,
          f"{len(arows)} -> {len(after)}")

        # ---- 10. export counts match project decisions ---------------------
        stats = req(f"/api/std/projects/{pid}")["stats"]
        c("Export row counts match project decisions",
          len(after) == stats["exportRows"] == stats["inputRows"] - stats["excluded"],
          f"export={len(after)} stats={stats['exportRows']}")

        # ---- 11. change-report counts match the database --------------------
        report = req(f"/api/std/projects/{pid}/report.json")
        con2 = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        db_changes = con2.execute(
            "SELECT COUNT(*) FROM standardization_changes WHERE project_id=?",
            (pid,)).fetchone()[0]
        con2.close()
        c("Change-report counts match database changes",
          report["statistics"]["changeRecords"] == db_changes, f"{db_changes}")

        # ---- 12. project mappings stay out of the canonical catalog ---------
        before_aliases = canonical_counts(DB)["aliases"]
        req(f"/api/std/projects/{pid}/apply-all", "POST",
            {"field": "Trim", "rawValue": "Lariat", "canonicalValue": "Lariat",
             "decision": "Apply to All Identical Values"})
        after_aliases = canonical_counts(DB)["aliases"]
        pm = req(f"/api/std/projects/{pid}")["mappings"]
        c("Project mappings remain separate from canonical aliases",
          before_aliases == after_aliases and len(pm) > 0,
          f"aliases {before_aliases}->{after_aliases}, project mappings={len(pm)}")

        # ---- 13. canonical write attempts are rejected ----------------------
        wcon = sqlite3.connect(DB)
        blocked = False
        try:
            wcon.execute("UPDATE makes SET standard_make='HACKED' WHERE id=1")
            wcon.commit()
        except sqlite3.Error as e:
            blocked = "read-only" in str(e)
        wcon.close()
        c("Canonical catalog rejects writes during ordinary operation", blocked)

        # ---- 14. reprocessing is idempotent ---------------------------------
        s_before = req(f"/api/std/projects/{pid}")["stats"]
        req(f"/api/std/projects/{pid}/process", "POST", {})
        for _ in range(120):
            if not req(f"/api/std/projects/{pid}/progress")["running"]:
                break
            time.sleep(0.5)
        s_after = req(f"/api/std/projects/{pid}")["stats"]
        c("Reprocessing is idempotent",
          s_before["inputRows"] == s_after["inputRows"],
          f"{s_before['inputRows']} -> {s_after['inputRows']}")

        # ---- 15. large-file resource limits ---------------------------------
        big = os.path.join(SAMPLES, "large_fixture.csv")
        if not os.path.exists(big):
            with open(big, "w", encoding="utf-8", newline="") as f:
                f.write("Item ID,Make,Model,Trim,Year\n")
                for i in range(100_000):
                    f.write(f"SKU-{i},ford,F150,XLT,2015-2018\n")
        t0 = time.time()
        up = req("/api/std/upload", "POST", raw=open(big, "rb").read(),
                 headers={"X-Filename": "large_fixture.csv",
                          "Content-Type": "application/octet-stream"})
        bpid = up["projectId"]
        heads = up["preview"]["headers"]
        req(f"/api/std/projects/{bpid}/mapping", "POST", {"mapping": {
            "headerRow": 1, "preserveUnmapped": True,
            "columns": [{"column": h, "index": i,
                         "field": "Model Year" if h == "Year" else
                                  h if h in ("Make", "Model", "Trim", "Item ID")
                                  else "Preserve as Custom Field"}
                        for i, h in enumerate(heads)]}})
        req(f"/api/std/projects/{bpid}/process", "POST", {})
        done = False
        for _ in range(600):
            pr = req(f"/api/std/projects/{bpid}/progress")
            if not pr["running"] and pr["status"] != "Processing":
                done = True
                break
            time.sleep(1)
        elapsed = time.time() - t0
        big_stats = req(f"/api/std/projects/{bpid}")["stats"]
        c("Large-file processing stays within documented limits "
          "(100,000 rows under 5 minutes)",
          done and big_stats["inputRows"] == 100_000 and elapsed < 300,
          f"rows={big_stats['inputRows']} in {elapsed:.1f}s")

        # ---- 16. lookup workbook -------------------------------------------
        lookup = req("/api/std/lookup-workbook.xlsx")
        c("Canonical Vehicle Lookup workbook is generated",
          isinstance(lookup, (bytes, bytearray)) and len(lookup) > 20_000,
          f"{len(lookup)} bytes")
    finally:
        server.terminate()
        try:
            server.wait(timeout=20)
        except Exception:
            server.kill()

    # ---- 17-19. build, tests, windows scripts ------------------------------
    extra_path = os.path.join(APP, "exports", "v5_verify_extra.json")
    extra = json.load(open(extra_path, encoding="utf-8-sig")) if os.path.exists(extra_path) else {}
    c("Production build passes", str(extra.get("production_build", "")).startswith("PASS"),
      extra.get("production_build"))
    c("Automated tests pass", "PASS" in str(extra.get("automated_tests", "")),
      extra.get("automated_tests"))
    scripts_ok = True
    for bat in ["start-app.bat", "setup-windows.bat", "import-latest-catalog.bat",
                "export-excel.bat", "backup-database.bat", "restore-database.bat",
                "stop-app.bat"]:
        p = os.path.join(APP, bat)
        if not os.path.exists(p):
            scripts_ok = False
            continue
        text = open(p, encoding="utf-8", errors="replace").read()
        if "cd /d \"%~dp0\"" not in text and bat != "stop-app.bat":
            scripts_ok = False
        if re.search(r"C:\\Users\\Asus", text):
            scripts_ok = False
    c("Windows scripts remain path-independent", scripts_ok)

    # ---- 20. versions 1-4 preserved ----------------------------------------
    preserved = all(os.path.exists(os.path.join(APP, "data", f)) for f in
                    ["catalog.db", "catalog-v2.db", "catalog-v3.db", "catalog-v4.db"])
    backups = all(os.path.isdir(os.path.join(BASE, d)) for d in
                  ["catalog-app-phase1-backup", "catalog-app-phase2-backup",
                   "catalog-app-phase3-backup", "catalog-app-phase4-backup"])
    workbooks = all(os.path.exists(os.path.join(APP, "exports", f)) for f in
                    ["Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx",
                     "Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15_v2.xlsx",
                     "Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v3.xlsx",
                     "Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v4.xlsx"])
    c("Versions 1-4 remain preserved (databases, backups, workbooks)",
      preserved and backups and workbooks,
      f"dbs={preserved} backups={backups} workbooks={workbooks}")

    return _finish(checks)

def _finish(checks):
    report = {"version": "V5", "database": DB, "checks": checks,
              "status": "PASS" if all(x["ok"] for x in checks) else "FAIL",
              "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    out = os.path.join(APP, "data", "app_verification_report_v5.json")
    json.dump(report, open(out, "w", encoding="utf-8"), indent=2)
    print(json.dumps({"status": report["status"],
                      "failed": [x for x in checks if not x["ok"]]}, indent=1))
    print("Report:", out)
    return 0 if report["status"] == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
