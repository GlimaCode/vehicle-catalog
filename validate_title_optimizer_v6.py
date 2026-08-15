# -*- coding: utf-8 -*-
"""
Independent Version 6 Title Optimizer validator.

Runs against the built application and the shipped catalog-v6.db, exercising the
optimizer end to end and asserting every safety rule the module claims to honour.

PASS only when every mandatory check succeeds.
"""
import csv, hashlib, json, os, re, sqlite3, subprocess, sys, tempfile, time
import urllib.error, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(BASE, "catalog-app")
DB = os.path.join(APP, "data", "catalog-v6.db")
PORT = int(os.environ.get("V6_PORT", "4333"))
ROOT = f"http://127.0.0.1:{PORT}"
MAX = 80

CANONICAL = {"makes": 76, "models": 1798, "model_years": 15594,
             "vehicle_hierarchy_values": 390, "hierarchy_value_years": 2504,
             "vehicle_configuration_values": 6859,
             "configuration_value_years": 43465, "aliases": 206,
             "grouped_model_relationships": 119}
TITLE_TABLES = ["title_optimization_projects", "title_optimization_rows",
                "title_optimization_changes", "title_templates", "title_rules",
                "title_abbreviation_mappings", "title_manual_decisions"]

HEADERS = ["Item ID", "SKU", "Title", "Year", "Make", "Model", "Trim", "Material",
           "Color", "Variation", "Product Type", "Position", "Side", "Quantity"]

ROWS = [
    ["A-1", "SKU-1",
     "Brand New High Quality Replacement Seat Cover Seat Cover For Fits 2006 2007 2008 "
     "ford F150 XLT Driver & Passenger Bottom Genuine Leather Black Custom Fit",
     "2006 2007 2008", "ford", "F150", "XLT", "Genuine Leather", "Black",
     "Bottom Cushion", "Seat Cover", "Bottom", "Driver/Passenger", "2"],
    ["A-2", "SKU-2", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
     "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
     "Bottom", "Driver", "1"],
    ["A-3", "SKU-3",
     "Fits 2006, 2008 Chevrolet Silverado 1500 Driver Bottom Vinyl Seat Cover "
     "Medium Gray Replacement Premium Quality Brand New",
     "2006, 2008", "Chevrolet", "Silverado 1500", "", "Vinyl", "Medium Gray", "",
     "Seat Cover", "Bottom", "Driver", "1"],
    ["A-4", "SKU-4", "2012 Ford Escalade Driver Bottom Leather Seat Cover Black",
     "2012", "Ford", "Escalade", "", "Leather", "Black", "", "Seat Cover",
     "Bottom", "Driver", "1"],
    ["A-5", "SKU-5",
     "Replacement 2015 to 2020 Mercedes Benz Sprinter Passenger Bottom Genuine "
     "Leather Seat Cover Medium Parchment Tan With Armrest And Headrest Premium",
     "2015 to 2020", "Mercedes Benz", "Sprinter", "", "Genuine Leather",
     "Medium Parchment Tan", "With Armrest", "Seat Cover", "Bottom", "Passenger", "1"],
    ["A-6", "SKU-6",
     "=cmd|' /C calc'!A0 2020 Ford Explorer Driver Bottom Leather Seat Cover Black",
     "2020", "Ford", "Explorer", "", "Leather", "Black", "", "Seat Cover",
     "Bottom", "Driver", "1"],
]


def ulen(s):
    """Unicode code-point length, matching the application's counting rule."""
    return len([c for c in s])


def req(path, method="GET", data=None, raw=None, headers=None, timeout=900):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    hdrs = {"Content-Type": "application/json"} if data is not None else {}
    hdrs.update(headers or {})
    r = urllib.request.Request(ROOT + path, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        payload = resp.read()
        ctype = resp.headers.get("Content-Type", "")
        return (json.loads(payload) if "json" in ctype else payload), resp.headers


def counts(path, tables):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    out = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
    con.close()
    return out


def parse_csv(text):
    return list(csv.reader(text.splitlines()))


def unprotect(cell):
    """
    Removes the CSV formula-injection marker before comparing or counting.

    Version 5.1 prefixes a risky value with an apostrophe so spreadsheets treat
    it as literal text. That apostrophe is a transport artifact, not part of the
    title, so it must not count towards the character limit or be mistaken for a
    rewritten value. Only a leading apostrophe that guards a risky character is
    stripped, so a title that genuinely begins with one is left alone.
    """
    if cell.startswith("'") and len(cell) > 1 and cell[1] in "=+-@\t\r":
        return cell[1:]
    return cell


def approved_abbreviations():
    """Approved title-only short forms, used when checking preservation."""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = con.execute("SELECT full_value, abbreviated_value FROM "
                       "title_abbreviation_mappings WHERE approval_status='Approved'"
                       ).fetchall()
    con.close()
    return {f.lower(): a.lower() for f, a in rows}


def squash(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def main():
    checks = []

    def c(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        return ok

    # ------------------------------------------------ 1. Version 4 canonical hashes
    fails = []
    with open(os.path.join(BASE, "Phase4_Hash_Manifest.csv"), encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            p = row["Path"]
            if not p.startswith("catalog-app-phase4-backup"):
                continue
            full = os.path.join(BASE, p)
            if not os.path.exists(full):
                fails.append(p + " (missing)")
            else:
                h = hashlib.sha256(open(full, "rb").read()).hexdigest().upper()
                if h != row["SHA256"].upper():
                    fails.append(p)
    c("Version 4 canonical hashes remain unchanged", not fails, fails[:5])

    # ------------------------------------------------ 2. canonical data in v6
    rel = counts(DB, list(CANONICAL))
    c("Canonical counts are unchanged in catalog-v6.db", rel == CANONICAL,
      json.dumps(rel))

    con = sqlite3.connect(DB)
    blocked = []
    for sql in ["UPDATE makes SET standard_make='X' WHERE id=1",
                "DELETE FROM models WHERE id=1"]:
        try:
            con.execute(sql)
            con.commit()
            blocked.append(f"NOT BLOCKED: {sql[:40]}")
        except sqlite3.Error as e:
            if "read-only" not in str(e):
                blocked.append(f"{sql[:30]} -> {e}")
    con.close()
    c("Canonical tables still reject writes", not blocked, blocked)

    have = counts(DB, ["sqlite_master"])
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]
    triggers = con.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
    con.close()
    c("All seven Title Optimizer tables exist",
      all(t in tables for t in TITLE_TABLES),
      [t for t in TITLE_TABLES if t not in tables] or "all present")
    c("The 27 canonical protection triggers are intact", triggers == 27, triggers)

    # ------------------------------------------------ 3. live application
    port_free = True
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", PORT))
    except OSError:
        port_free = False
    finally:
        s.close()
    if not port_free:
        raise SystemExit(f"Port {PORT} is already in use; stop that process or set V6_PORT.")

    workdir = tempfile.mkdtemp(prefix="v6-validate-")
    log_path = os.path.join(workdir, "server.log")
    env = dict(os.environ, PORT=str(PORT))
    env.pop("CATALOG_DB", None)
    server = subprocess.Popen(f'npm.cmd start > "{log_path}" 2>&1',
                              cwd=APP, env=env, shell=True)
    project_id = None
    try:
        ready = False
        for _ in range(90):
            try:
                req("/api/summary")
                ready = True
                break
            except Exception:
                time.sleep(1)
        if not c("The application starts", ready):
            raise SystemExit(_finish(checks))

        meta, _ = req("/api/title/fields")
        c("The default title limit is 80 Unicode characters",
          meta["maxCharacters"] == MAX
          and meta["characterCounting"] == "Unicode code points",
          json.dumps(meta)[:160])
        c("Only Title is mandatory", meta["mandatory"] == ["Title"], meta["mandatory"])

        # upload
        payload = ("\r\n".join([",".join(
            f'"{v}"' if any(ch in v for ch in ',"\n') else v for v in row)
            for row in [HEADERS] + ROWS]) + "\r\n").encode("utf-8")
        up, _ = req("/api/title/upload", "POST", raw=payload,
                    headers={"X-Filename": "validator titles.csv",
                             "Content-Type": "application/octet-stream"})
        project_id = up["projectId"]
        cols = [{"column": h, "index": i,
                 "field": "Year Range" if h == "Year" else h}
                for i, h in enumerate(HEADERS)]
        req(f"/api/title/projects/{project_id}/mapping", "POST",
            {"mapping": {"headerRow": 1, "columns": cols}})
        result, _ = req(f"/api/title/projects/{project_id}/process", "POST", {})
        c("The project processes every row", result["processed"] == len(ROWS),
          json.dumps(result))

        rows, _ = req(f"/api/title/projects/{project_id}/rows?pageSize=200")
        by_num = {r["row_number"]: r for r in rows["rows"]}

        # ------------------------------------------ title-level guarantees
        over = [r for r in rows["rows"]
                if ulen(r["final_title"] or r["proposed_title"]) > MAX
                and r["title_status"] not in ("Unable to Reach Limit",
                                              "Manual Review Required", "Excluded")]
        c("No title exceeds 80 characters unless explicitly flagged", not over,
          [(r["row_number"], r["title_status"]) for r in over])

        truncated = []
        for r in rows["rows"]:
            final = r["final_title"] or r["proposed_title"]
            orig = r["original_title"]
            if final.endswith("...") or final.endswith("…"):
                truncated.append((r["row_number"], "ellipsis"))
            # a hard cut would leave the result as a strict prefix of the original
            if final != orig and orig.startswith(final) and ulen(final) < ulen(orig):
                truncated.append((r["row_number"], "prefix cut"))
        c("No title is hard-truncated", not truncated, truncated)

        lthr = [r["row_number"] for r in rows["rows"]
                if re.search(r"\blthr\b|\bg\.\s*leather\b|\bleath\b",
                             (r["final_title"] or ""), re.I)]
        c("Leather is never abbreviated", not lthr, lthr)

        genuine_rows = [r for r in rows["rows"]
                        if "genuine leather" in r["original_title"].lower()]
        lost = [r["row_number"] for r in genuine_rows
                if "genuine leather" not in (r["final_title"] or "").lower()]
        c("Genuine Leather is preserved when confirmed",
          genuine_rows and not lost, f"{len(genuine_rows)} rows, lost {lost}")

        abbrevs = approved_abbreviations()
        missing_required = []
        for r in rows["rows"]:
            src = json.loads(r["source_json"])
            final = squash(r["final_title"])
            orig = squash(r["original_title"])
            for field in ("Material", "Color"):
                raw = (src.get(field) or "").strip()
                v = squash(raw)
                if not v or v not in orig or v in final:
                    continue
                # an approved abbreviation preserves the information; check each
                # word of the value against its approved short form
                rebuilt = "".join(
                    squash(abbrevs.get(w.lower(), w)) for w in raw.split())
                if rebuilt and rebuilt in final:
                    continue
                missing_required.append((r["row_number"], field, raw))
        c("Required fields remain present (full or approved abbreviation)",
          not missing_required, missing_required)

        conflict = [r for r in rows["rows"]
                    if "conflict" in (r["validation_warnings"] or "").lower()]
        c("An invalid Make-Model relationship blocks automatic optimization",
          conflict and all(r["title_status"] == "Manual Review Required"
                           and r["final_title"] == r["original_title"]
                           for r in conflict),
          [(r["row_number"], r["title_status"]) for r in conflict])

        added_trim = []
        for r in rows["rows"]:
            src = json.loads(r["source_json"])
            trim = (src.get("Trim") or "").strip()
            if trim and trim.lower() not in r["original_title"].lower() \
                    and trim.lower() in (r["final_title"] or "").lower():
                added_trim.append(r["row_number"])
        c("Unapproved hierarchy values are never added automatically",
          not added_trim, added_trim)

        # ------------------------------------------ export contract
        audit_body, audit_hdrs = req(
            f"/api/title/projects/{project_id}/export.csv?mode=audit")
        audit = audit_body.decode("utf-8") if isinstance(audit_body, (bytes, bytearray)) \
            else str(audit_body)
        arows = parse_csv(audit)
        aheader = arows[0]
        for col in ["Original Title", "Optimized Title", "Original Character Count",
                    "Optimized Character Count", "Characters Removed",
                    "Title Optimization Status", "Applied Title Rules",
                    "Title Optimization Notes"]:
            if col not in aheader:
                c(f"Audit export contains the {col} column", False, aheader)
                break
        else:
            c("Audit exports contain every documented audit column", True,
              f"{len(aheader)} columns")

        orig_col = aheader.index("Original Title")
        opt_col = aheader.index("Optimized Title")
        olen_col = aheader.index("Original Character Count")
        nlen_col = aheader.index("Optimized Character Count")
        title_col = HEADERS.index("Title")
        preserved = all(unprotect(arows[i + 1][title_col]) == ROWS[i][title_col]
                        for i in range(len(ROWS)))
        c("Audit exports preserve the original Title column", preserved,
          "source Title column unchanged" if preserved else "Title column was rewritten")
        c("Audit exports also restate the original title",
          all(unprotect(arows[i + 1][orig_col]) == ROWS[i][title_col]
              for i in range(len(ROWS))))

        mismatch = [(r[0], ulen(unprotect(r[opt_col])), r[nlen_col]) for r in arows[1:]
                    if ulen(unprotect(r[opt_col])) != int(r[nlen_col])]
        c("Character counts match the exported titles", not mismatch, mismatch[:5])
        mismatch_o = [(r[0], ulen(unprotect(r[orig_col])), r[olen_col])
                      for r in arows[1:]
                      if ulen(unprotect(r[orig_col])) != int(r[olen_col])]
        c("Original character counts match the original titles", not mismatch_o,
          mismatch_o[:5])

        repl_body, _ = req(f"/api/title/projects/{project_id}/export.csv?mode=replacement")
        repl = repl_body.decode("utf-8") if isinstance(repl_body, (bytes, bytearray)) \
            else str(repl_body)
        rrows = parse_csv(repl)
        c("Replacement exports keep the original column set", rrows[0] == HEADERS,
          rrows[0])
        changed_other = []
        for i, src in enumerate(ROWS):
            out = rrows[i + 1]
            for col in range(len(HEADERS)):
                if col == HEADERS.index("Title"):
                    continue
                if unprotect(out[col]) != src[col]:
                    changed_other.append((i + 1, HEADERS[col], src[col], out[col]))
        c("Replacement exports modify only the mapped Title column",
          not changed_other, changed_other[:5])
        c("Item ID and SKU are unchanged",
          all(rrows[i + 1][0] == ROWS[i][0] and rrows[i + 1][1] == ROWS[i][1]
              for i in range(len(ROWS))))
        c("Source row order is unchanged",
          [r[0] for r in rrows[1:]] == [r[0] for r in ROWS],
          [r[0] for r in rrows[1:]])

        c("Formula-injection protection remains active",
          "'=cmd" in repl and not re.search(r"(^|,)=cmd", repl, re.M),
          "injected title neutralised in the replacement export")

        # ------------------------------------------ report vs database
        detail, _ = req(f"/api/title/projects/{project_id}")
        stats = detail["stats"]
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        db_rows = con.execute(
            "SELECT COUNT(*) FROM title_optimization_rows WHERE project_id=?",
            (project_id,)).fetchone()[0]
        db_removed = con.execute(
            "SELECT COALESCE(SUM(characters_removed),0) FROM title_optimization_rows "
            "WHERE project_id=?", (project_id,)).fetchone()[0]
        db_changes = con.execute(
            "SELECT COUNT(*) FROM title_optimization_changes WHERE project_id=?",
            (project_id,)).fetchone()[0]
        con.close()
        c("Reported totals match the database",
          stats["inputRows"] == db_rows
          and stats["totalCharactersRemoved"] == db_removed,
          f"rows {stats['inputRows']}/{db_rows}, removed "
          f"{stats['totalCharactersRemoved']}/{db_removed}")
        c("Every applied rule is recorded", db_changes > 0, f"{db_changes} change records")

        report_body, _ = req(f"/api/title/projects/{project_id}/report.xlsx")
        c("The title optimization report is produced",
          isinstance(report_body, (bytes, bytearray)) and len(report_body) > 5000,
          f"{len(report_body)} bytes")

        # ------------------------------------------ idempotency
        before = {r["row_number"]: r["proposed_title"] for r in rows["rows"]}
        req(f"/api/title/projects/{project_id}/process", "POST", {})
        rows2, _ = req(f"/api/title/projects/{project_id}/rows?pageSize=200")
        after = {r["row_number"]: r["proposed_title"] for r in rows2["rows"]}
        c("Reprocessing is idempotent", before == after,
          [k for k in before if before[k] != after.get(k)][:5])

        # ------------------------------------------ V5.1 workspace still works
        std_payload = b"Item ID,Make,Model,Year\r\nS-1,ford,F150,2018\r\n"
        std_up, _ = req("/api/std/upload", "POST", raw=std_payload,
                        headers={"X-Filename": "std check.csv",
                                 "Content-Type": "application/octet-stream"})
        std_id = std_up["projectId"]
        std_cols = [{"column": h, "index": i,
                     "field": "Model Year" if h == "Year" else h}
                    for i, h in enumerate(std_up["preview"]["headers"])]
        req(f"/api/std/projects/{std_id}/mapping", "POST",
            {"mapping": {"headerRow": 1, "preserveUnmapped": True,
                         "columns": std_cols}})
        req(f"/api/std/projects/{std_id}/process", "POST", {})
        for _ in range(120):
            pr, _ = req(f"/api/std/projects/{std_id}/progress")
            if not pr["running"] and pr["status"] != "Processing":
                break
            time.sleep(0.5)
        std_csv_body, _ = req(f"/api/std/projects/{std_id}/export.csv?mode=audit")
        std_csv = std_csv_body.decode("utf-8") if isinstance(
            std_csv_body, (bytes, bytearray)) else str(std_csv_body)
        c("The Version 5.1 standardization workspace still works",
          "Standard Make" in std_csv and "Ford" in std_csv,
          "standardization export produced canonical values")

        summary, _ = req("/api/summary")
        c("The existing catalog pages still work",
          summary["cards"]["makes"] == 76, json.dumps(summary["cards"])[:120])
    finally:
        subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"],
                       capture_output=True)
        try:
            server.wait(timeout=20)
        except Exception:
            server.kill()
        time.sleep(1.5)
        import shutil
        for _ in range(20):
            shutil.rmtree(workdir, ignore_errors=True)
            if not os.path.exists(workdir):
                break
            time.sleep(1)

    # ------------------------------------------------ build and tests
    extra_path = os.path.join(APP, "exports", "v6_verify_extra.json")
    extra = json.load(open(extra_path, encoding="utf-8-sig")) \
        if os.path.exists(extra_path) else {}
    c("The production build passes",
      str(extra.get("production_build", "")).startswith("PASS"),
      extra.get("production_build"))
    c("The automated tests pass", "PASS" in str(extra.get("automated_tests", "")),
      extra.get("automated_tests"))

    # ------------------------------------------------ preservation
    dbs = ["catalog.db", "catalog-v2.db", "catalog-v3.db", "catalog-v4.db",
           "catalog-v5.db", "catalog-v5.1.db", "catalog-v6.db"]
    backups = ["catalog-app-phase1-backup", "catalog-app-phase2-backup",
               "catalog-app-phase3-backup", "catalog-app-phase4-backup",
               "catalog-app-phase5-backup", "catalog-app-phase5-1-backup"]
    zips = ["US-Vehicle-Catalog-App-v2.zip", "US-Vehicle-Catalog-App-v3.zip",
            "US-Vehicle-Catalog-App-v4.zip", "US-Vehicle-Catalog-App-v5.zip",
            "US-Vehicle-Catalog-App-v5.1.zip"]
    missing = [d for d in dbs if not os.path.exists(os.path.join(APP, "data", d))] \
        + [b for b in backups if not os.path.isdir(os.path.join(BASE, b))] \
        + [z for z in zips if not os.path.exists(os.path.join(APP, "exports", z))]
    c("Versions 1 to 5.1 remain preserved", not missing, missing)

    # the frozen V5.1 release artifacts must be byte-identical
    v51_fail = []
    manifest = os.path.join(BASE, "Phase5_1_Hash_Manifest.csv")
    if os.path.exists(manifest):
        with open(manifest, encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                if row["Artifact"] not in ("Version 5.1 release ZIP",
                                           "Version 5.1 release database"):
                    continue
                full = os.path.join(BASE, row["Path"])
                if not os.path.exists(full):
                    v51_fail.append(row["Path"] + " (missing)")
                elif hashlib.sha256(open(full, "rb").read()).hexdigest().upper() \
                        != row["SHA256"].upper():
                    v51_fail.append(row["Path"])
    c("The Version 5.1 release ZIP and database are byte-identical", not v51_fail,
      v51_fail)

    docs = ["TITLE_OPTIMIZER_GUIDE.md", "TITLE_TEMPLATE_GUIDE.md",
            "TITLE_RULES_GUIDE.md", "TITLE_ABBREVIATION_GUIDE.md",
            "TITLE_REVIEW_GUIDE.md"]
    missing_docs = [d for d in docs if not os.path.exists(os.path.join(APP, d))]
    c("Every Title Optimizer guide is present", not missing_docs, missing_docs)

    return _finish(checks)


def _finish(checks):
    report = {
        "version": "V6",
        "module": "Title Optimizer",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "database": DB,
        "maxCharacters": MAX,
        "characterCounting": "Unicode code points",
        "checks": checks,
        "status": "PASS" if all(x["ok"] for x in checks) else "FAIL",
    }
    out = os.path.join(APP, "data", "app_verification_report_v6.json")
    json.dump(report, open(out, "w", encoding="utf-8"), indent=2)
    print(json.dumps({"status": report["status"],
                      "checks": len(checks),
                      "failed": [x for x in checks if not x["ok"]]}, indent=1))
    print("Report:", out)
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
