# -*- coding: utf-8 -*-
"""
Independent Version 5.1 hardening validator.

Verifies the production-hardening work end to end: canonical immutability,
formula-injection protection, malicious-workbook limits, path confinement,
localhost-only binding, retention/deletion, crash recovery, backup/restore,
release-database purity, both large-file fixtures, build, tests, Windows
scripts and preservation of Versions 1-5.

PASS only when every mandatory automated check succeeds. The clean Windows
installation status is reported separately and is never inferred.
"""
import csv, hashlib, json, os, re, sqlite3, subprocess, sys, time, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(BASE, "catalog-app")
RELEASE_DB = os.path.join(APP, "data", "catalog-v5.1.db")
PORT = int(os.environ.get("V51_PORT", "4321"))
ROOT = f"http://127.0.0.1:{PORT}"
SAMPLES = os.path.join(APP, "samples")
EXPORTS = os.path.join(APP, "exports")

CANONICAL_TABLES = ["makes", "models", "model_years", "vehicle_hierarchy_values",
                    "hierarchy_value_years", "vehicle_configuration_values",
                    "configuration_value_years", "aliases",
                    "grouped_model_relationships"]
EXPECTED_CANONICAL = {"makes": 76, "models": 1798, "model_years": 15594,
                      "vehicle_hierarchy_values": 390, "hierarchy_value_years": 2504,
                      "vehicle_configuration_values": 6859,
                      "configuration_value_years": 43465, "aliases": 206,
                      "grouped_model_relationships": 119}

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def req(path, method="GET", data=None, headers=None, raw=None, timeout=180):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    hdrs = {"Content-Type": "application/json"} if data is not None else {}
    hdrs.update(headers or {})
    r = urllib.request.Request(ROOT + path, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        payload = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        parsed = json.loads(payload) if "json" in ctype else payload
        return parsed, resp.headers, resp.status

def counts(db_path, tables):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    out = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
    con.close()
    return out

def main():
    checks = []
    def c(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        return ok

    # ------------------------------------------------ 1. V4 hashes unchanged
    manifest = list(csv.DictReader(open(os.path.join(BASE, "Phase4_Hash_Manifest.csv"),
                                        encoding="utf-8-sig")))
    fails = []
    for row in manifest:
        p = row["Path"]
        if not p.startswith("catalog-app-phase4-backup"):
            continue                        # the frozen V4 snapshot is the reference
        full = os.path.join(BASE, p)
        if not os.path.exists(full):
            fails.append(p + " (missing)")
        elif sha256(full).upper() != row["SHA256"].upper():
            fails.append(p)
    c("Version 4 canonical hashes remain unchanged", not fails, fails[:5])

    # ------------------------------------------------ 2. canonical protected
    rel = counts(RELEASE_DB, CANONICAL_TABLES)
    c("Canonical tables are unchanged in the release database",
      rel == EXPECTED_CANONICAL, json.dumps(rel))
    wcon = sqlite3.connect(RELEASE_DB)
    blocked = []
    for sql in ["UPDATE makes SET standard_make='X' WHERE id=1",
                "DELETE FROM models WHERE id=1",
                "INSERT INTO aliases (raw_or_alias_make, raw_or_alias_model, alias_type,"
                " norm_make, norm_model) VALUES ('a','b','c','A','B')"]:
        try:
            wcon.execute(sql)
            wcon.commit()
            blocked.append(f"NOT BLOCKED: {sql[:40]}")
        except sqlite3.Error as e:
            if "read-only" not in str(e):
                blocked.append(f"{sql[:30]} -> {e}")
    wcon.close()
    c("Canonical tables reject writes (SQLite triggers)", not blocked, blocked)

    audit_doc = os.path.join(APP, "Canonical_Immutability_Security_Audit.md")
    grep = subprocess.run(["node", "-e",
        "const fs=require('fs'),p=require('path');let hits=[];"
        "const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){"
        "const f=p.join(d,e.name);if(e.isDirectory())walk(f);"
        "else if(/\\.ts$/.test(e.name)){const t=fs.readFileSync(f,'utf8')"
        ".replace(/\\/\\*[\\s\\S]*?\\*\\//g,'').replace(/\\/\\/.*/g,'');"  # strip comments
        "if(/withCanonicalUnlocked\\s*\\(/.test(t)&&!/canonical_lock\\.ts$/.test(f))hits.push(f);}}};"
        "walk('server');console.log(JSON.stringify(hits));"],
        cwd=APP, capture_output=True, text=True)
    call_sites = json.loads(grep.stdout.strip() or "[]")
    importer_only = all(re.search(r"importer(_v[234])?\.ts$", s) for s in call_sites)
    c("Canonical unlock is confined to the catalog importers",
      importer_only and os.path.exists(audit_doc),
      f"{len(call_sites)} call site(s): {[os.path.basename(s) for s in call_sites]}")

    # ------------------------------------------------ 3. release database
    inspect = json.load(open(os.path.join(EXPORTS, "Release_Database_Inspection_Report.json"),
                             encoding="utf-8-sig"))
    c("Release database inspection passed", inspect["status"] == "PASS",
      json.dumps([x for x in inspect["checks"] if not x["ok"]])[:200])
    con = sqlite3.connect(f"file:{RELEASE_DB}?mode=ro", uri=True)
    proj = con.execute("SELECT COUNT(*) FROM standardization_projects").fetchone()[0]
    rows = con.execute("SELECT COUNT(*) FROM standardization_rows").fetchone()[0]
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    wal = RELEASE_DB + "-wal"
    c("Release database is pristine (no benchmark/validator/user projects)",
      proj == 0 and rows == 0, f"projects={proj} rows={rows}")
    c("Release database passes integrity check and has a clean WAL",
      integrity == "ok" and (not os.path.exists(wal) or os.path.getsize(wal) == 0),
      f"integrity={integrity}")

    # ------------------------------------------------ 4. reports exist
    perf = json.load(open(os.path.join(EXPORTS, "Large_File_Performance_Report.json"),
                          encoding="utf-8-sig"))
    fa = next(f for f in perf["fixtures"] if "Fixture A" in f["fixture"])
    fb = next(f for f in perf["fixtures"] if "Fixture B" in f["fixture"])
    c("Large-file Fixture A (100,000 x 100) passes",
      fa["resultStatus"] == "PASS" and fa["rowCount"] == 100000 and fa["columnCount"] == 100,
      f"{fa['rowCount']}x{fa['columnCount']} peakRSS={fa['peakRssMB']}MB")
    c("Large-file Fixture B (250,000 x 20) passes",
      fb["resultStatus"] == "PASS" and fb["rowCount"] == 250000,
      f"{fb['rowCount']}x{fb['columnCount']} peakRSS={fb['peakRssMB']}MB")
    c("Performance report exists in both JSON and CSV",
      os.path.exists(os.path.join(EXPORTS, "Large_File_Performance_Report.csv")))
    backup_report = json.load(open(os.path.join(EXPORTS,
        "Backup_Restore_Validation_Report.json"), encoding="utf-8-sig"))
    c("Backup and restore round trip passed", backup_report["status"] == "PASS",
      json.dumps([x for x in backup_report["checks"] if not x["ok"]])[:200])

    # ------------------------------------------------ 5. live server checks
    # The live section creates and deletes projects, so it runs against a copy.
    # The shipped release database must stay pristine.
    import shutil, tempfile
    workdir = tempfile.mkdtemp(prefix="v51-validate-")
    LIVE_DB = os.path.join(workdir, "catalog-v5.1.db")
    src = sqlite3.connect(RELEASE_DB)
    src.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    src.execute("VACUUM INTO ?", (LIVE_DB,))
    src.close()
    env = dict(os.environ, PORT=str(PORT), CATALOG_DB=LIVE_DB,
               CATALOG_UPLOADS=os.path.join(workdir, "uploads"))
    # Refuse to run against a server this validator did not start: a leftover
    # process on the port would silently be tested instead of the current build.
    import socket as _s
    probe_sock = _s.socket()
    try:
        probe_sock.bind(("127.0.0.1", PORT))
    except OSError:
        raise SystemExit(f"Port {PORT} is already in use. Stop the process listening "
                         f"on it (or set V51_PORT) and re-run.")
    finally:
        probe_sock.close()

    # Seed a project stuck in Processing (as a crash would leave it) plus a
    # stray .part file, so startup recovery has something real to repair.
    seed = sqlite3.connect(LIVE_DB)
    seed.execute("""INSERT INTO standardization_projects
        (project_name, input_filename, input_file_hash, input_format, status,
         row_count, processed_rows, stored_path, mapping_json,
         created_at, updated_at)
        VALUES ('crash-recovery probe','probe.csv','0'||'0','CSV','Processing',
                500,120,NULL,NULL,
                datetime('now','-1 hour'),datetime('now','-1 hour'))""")
    seed.commit()
    probe_id = seed.execute("SELECT MAX(id) FROM standardization_projects").fetchone()[0]
    seed.close()
    stray = os.path.join(APP, "exports", "recovery-probe.abc123.part")
    open(stray, "w").write("partial")

    # cmd owns the redirect: a Python-owned handle shared between npm.cmd and its
    # node child loses the app's startup lines on Windows
    log_path = os.path.join(workdir, "server.log")
    server = subprocess.Popen(f'npm.cmd start > "{log_path}" 2>&1',
                              cwd=APP, env=env, shell=True)
    bind_info, banner = {}, []
    try:
        ready = False
        for _ in range(90):
            try:
                req("/api/summary")
                ready = True
                break
            except Exception:
                time.sleep(1)
        c("Application starts", ready)
        bind_info = req("/api/admin/binding")[0]

        # crash recovery must already have run before the first request
        probe = req(f"/api/std/projects/{probe_id}")[0]["project"]
        recovered = probe["status"] in ("Failed", "Mapped") \
            and "Interrupted during processing" in (probe.get("recovery_state") or "")
        c("Crash recovery repairs interrupted jobs and sweeps partial files",
          recovered and not os.path.exists(stray),
          f"status={probe['status']} state={(probe.get('recovery_state') or '')[:90]} "
          f"strayRemoved={not os.path.exists(stray)}")
        if not ready:
            raise SystemExit(_finish(checks, "Not Verified - Environment Unavailable"))

        # localhost-only binding: the app must not answer on a LAN address
        lan_ok = True
        try:
            import socket
            host = socket.gethostbyname(socket.gethostname())
            if host != "127.0.0.1":
                try:
                    urllib.request.urlopen(f"http://{host}:{PORT}/api/summary", timeout=3)
                    lan_ok = False          # reachable off-loopback = fail
                except Exception:
                    lan_ok = True
        except Exception:
            pass
        c("Server binds to localhost only by default", lan_ok)

        hdrs = req("/api/summary")[1]
        c("Security headers are applied",
          hdrs.get("X-Content-Type-Options") == "nosniff"
          and "frame-ancestors 'none'" in (hdrs.get("Content-Security-Policy") or ""),
          hdrs.get("Content-Security-Policy", "")[:80])

        cors_blocked = False
        try:
            req("/api/summary", headers={"Origin": "https://evil.example"})
        except urllib.error.HTTPError as e:
            cors_blocked = e.code == 403
        c("Cross-origin requests are refused", cors_blocked)

        # upload a formula-laden CSV
        payload = ("Item ID,Title,Make,Model,Trim,Year,Notes\r\n"
                   "A1,Cover,ford,F150,XLT,2018,=cmd|' /C calc'!A0\r\n"
                   "A2,Cover,Chevrolet,Escalade,LTZ,2012,-12.5\r\n").encode()
        up, _, _ = req("/api/std/upload", "POST", raw=payload,
                       headers={"X-Filename": "formula check.csv",
                                "Content-Type": "application/octet-stream"})
        pid = up["projectId"]
        cols = [{"column": h, "index": i,
                 "field": "Model Year" if h == "Year" else
                          h if h in ("Make", "Model", "Trim", "Title", "Item ID")
                          else "Preserve as Custom Field"}
                for i, h in enumerate(up["preview"]["headers"])]
        req(f"/api/std/projects/{pid}/mapping", "POST",
            {"mapping": {"headerRow": 1, "preserveUnmapped": True, "columns": cols}})
        req(f"/api/std/projects/{pid}/process", "POST", {})
        for _ in range(120):
            pr, _, _ = req(f"/api/std/projects/{pid}/progress")
            if not pr["running"] and pr["status"] != "Processing":
                break
            time.sleep(0.5)

        csv_body, csv_hdrs, _ = req(f"/api/std/projects/{pid}/export.csv?mode=audit")
        text = csv_body.decode("utf-8") if isinstance(csv_body, (bytes, bytearray)) else str(csv_body)
        c("Formula-injection protection works",
          "'=cmd" in text and not re.search(r"(^|,)=cmd", text, re.M)
          and "Formula Injection Protection Applied" in text
          and csv_hdrs.get("X-Formula-Injection-Protection-Applied") == "Enabled"
          and "-12.5" in text,                       # negative numbers untouched
          csv_hdrs.get("X-Formula-Injection-Protection-Applied"))

        # malicious workbook rejection
        rejected = 0
        reasons = []
        for name, blob in [("bomb.xlsx", b"PK\x03\x04" + b"\x00" * 40),
                           ("macro.xlsm", b"PK\x03\x04" + b"\x00" * 40),
                           ("fake.xlsx", b"Make,Model\nFord,F-150\n")]:
            try:
                req("/api/std/upload", "POST", raw=blob,
                    headers={"X-Filename": name, "Content-Type": "application/octet-stream"})
            except urllib.error.HTTPError as e:
                if e.code == 415:
                    rejected += 1
                    reasons.append(name)
        c("Malicious/mismatched workbooks are rejected", rejected == 3, reasons)

        # path confinement: a traversal filename must not escape uploads/
        trav, _, _ = req("/api/std/upload", "POST",
                         raw=b"Make,Model\nFord,F-150\n",
                         headers={"X-Filename": "../../escape.csv",
                                  "Content-Type": "application/octet-stream"})
        escaped = os.path.exists(os.path.join(BASE, "escape.csv")) \
            or os.path.exists(os.path.join(APP, "escape.csv"))
        stored_ok = trav["filename"] == "escape.csv"
        c("File paths remain confined to the application directories",
          not escaped and stored_ok, f"display={trav.get('filename')}")

        # deletion preview + execution, canonical untouched
        before = counts(LIVE_DB, ["makes", "models"])
        prev, _, _ = req(f"/api/std/projects/{pid}/deletion-preview?scope=project")
        delres, _, _ = req(f"/api/std/projects/{pid}?scope=project&reason=v5.1%20validator",
                           "DELETE")
        after = counts(LIVE_DB, ["makes", "models"])
        c("Project deletion previews, deletes and leaves canonical records intact",
          prev["canonicalRecordsAffected"] == 0 and delres["ok"] and before == after,
          f"rows previewed={prev['rows']} canonical {before} -> {after}")

        retention, _, _ = req("/api/std/retention")
        c("Deletion is audited and temporary files are managed",
          any(d["scope"] == "project" for d in retention["deletions"])
          and retention["policy"]["deleteTemporaryFilesAfterExport"] is True,
          f"{len(retention['deletions'])} deletion record(s)")
    finally:
        # terminate() only kills the npm.cmd wrapper; the node child would keep
        # the SQLite handle open, so kill the whole process tree
        subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"],
                       capture_output=True)
        try:
            server.wait(timeout=20)
        except Exception:
            server.kill()
        if os.path.exists(stray):
            os.remove(stray)
        # Windows keeps the SQLite handle briefly after the process exits
        for _ in range(20):
            shutil.rmtree(workdir, ignore_errors=True)
            if not os.path.exists(workdir):
                break
            time.sleep(1)
    c("Validator leaves no temporary working files behind",
      not os.path.exists(workdir), workdir)

    c("The application reports a local-only bind address",
      bind_info.get("bindAddress") == "127.0.0.1"
      and bind_info.get("allowLanAccess") is False
      and "local machine only" in bind_info.get("summary", ""),
      json.dumps(bind_info))

    # ------------------------------------------------ 6. build, tests, scripts
    extra_path = os.path.join(EXPORTS, "v51_verify_extra.json")
    extra = json.load(open(extra_path, encoding="utf-8-sig")) if os.path.exists(extra_path) else {}
    c("Production build passes", str(extra.get("production_build", "")).startswith("PASS"),
      extra.get("production_build"))
    c("Automated tests pass", "PASS" in str(extra.get("automated_tests", "")),
      extra.get("automated_tests"))

    scripts_ok, script_detail = True, []
    for bat in ["setup-windows.bat", "start-app.bat", "stop-app.bat",
                "import-latest-catalog.bat", "export-excel.bat",
                "backup-database.bat", "restore-database.bat"]:
        p = os.path.join(APP, bat)
        if not os.path.exists(p):
            scripts_ok = False
            script_detail.append(f"{bat} missing")
            continue
        text = open(p, encoding="utf-8", errors="replace").read()
        if bat != "stop-app.bat" and 'cd /d "%~dp0"' not in text:
            scripts_ok = False
            script_detail.append(f"{bat} not path-independent")
        if re.search(r"C:\\Users\\Asus", text):
            scripts_ok = False
            script_detail.append(f"{bat} contains a hard-coded path")
    c("Windows scripts remain path-independent", scripts_ok, script_detail)

    # ------------------------------------------------ 7. preservation
    dbs = ["catalog.db", "catalog-v2.db", "catalog-v3.db", "catalog-v4.db",
           "catalog-v5.db", "catalog-v5.1.db"]
    backups = ["catalog-app-phase1-backup", "catalog-app-phase2-backup",
               "catalog-app-phase3-backup", "catalog-app-phase4-backup",
               "catalog-app-phase5-backup"]
    zips = ["US-Vehicle-Catalog-App-v2.zip", "US-Vehicle-Catalog-App-v3.zip",
            "US-Vehicle-Catalog-App-v4.zip", "US-Vehicle-Catalog-App-v5.zip"]
    missing = [d for d in dbs if not os.path.exists(os.path.join(APP, "data", d))] \
        + [b for b in backups if not os.path.isdir(os.path.join(BASE, b))] \
        + [z for z in zips if not os.path.exists(os.path.join(EXPORTS, z))]
    c("Versions 1-5 remain preserved (databases, backups, release ZIPs)",
      not missing, missing)

    docs = ["SECURITY_GUIDE.md", "DATA_RETENTION_GUIDE.md", "SAFE_FILE_HANDLING_GUIDE.md",
            "BACKUP_RESTORE_GUIDE.md", "CRASH_RECOVERY_GUIDE.md",
            "CLEAN_INSTALL_VALIDATION.md", "Canonical_Immutability_Security_Audit.md"]
    missing_docs = [d for d in docs if not os.path.exists(os.path.join(APP, d))]
    c("Every hardening change is documented", not missing_docs, missing_docs)

    # clean Windows install status is read from the report, never inferred
    status_file = os.path.join(APP, "CLEAN_INSTALL_VALIDATION.md")
    clean_status = "Not Verified - Environment Unavailable"
    if os.path.exists(status_file):
        text = open(status_file, encoding="utf-8", errors="replace").read()
        m = re.search(r"^Status:\s*`?([^`\n]+)`?", text, re.M)
        if m:
            clean_status = m.group(1).strip()
    return _finish(checks, clean_status)

def _finish(checks, clean_status):
    report = {
        "version": "V5.1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "database": RELEASE_DB,
        "checks": checks,
        "cleanWindowsInstallation": clean_status,
        "status": "PASS" if all(x["ok"] for x in checks) else "FAIL",
    }
    out = os.path.join(APP, "data", "app_verification_report_v5_1.json")
    json.dump(report, open(out, "w", encoding="utf-8"), indent=2)
    print(json.dumps({"status": report["status"],
                      "cleanWindowsInstallation": clean_status,
                      "failed": [x for x in checks if not x["ok"]]}, indent=1))
    print("Report:", out)
    return 0 if report["status"] == "PASS" else 1

if __name__ == "__main__":
    sys.exit(main())
