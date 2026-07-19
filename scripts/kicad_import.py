#!/usr/bin/env python3
"""
Headless driver for importing LCSC parts into a KiCad project, reusing the
engine from the kicad-lcsc-manager plugin (github.com/hulryung/kicad-lcsc-manager)
so the AI skill and the KiCad GUI plugin share one import pipeline: same library
layout, overwrite handling, JLCPCB metadata, and sym/fp-lib-table registration.

Invoked by the jlcpcb-skill-mcp `import_part_to_kicad` MCP tool — not meant to be
run by hand. Emits exactly one line to stdout prefixed with the marker
`__RESULT__` followed by a JSON object; engine logs go to stderr.

  python3 kicad_import.py --project <path> --lcsc C25804 [C7593 ...] \
      [--symbol] [--footprint] [--3d] [--overwrite] [--manager-path <dir>]

If none of --symbol/--footprint/--3d are given, all three are imported.
"""
import argparse
import json
import logging
import os
import sys
from pathlib import Path

MARKER = "__RESULT__"


def find_manager(explicit: str | None) -> Path | None:
    """Locate the kicad-lcsc-manager checkout/install (its `plugins` dir)."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    if os.environ.get("KICAD_LCSC_MANAGER"):
        candidates.append(Path(os.environ["KICAD_LCSC_MANAGER"]))
    home = Path.home()
    candidates += [
        home / "dev" / "kicad-lcsc-manager",
        # Common KiCad 9 PCM third-party install locations (macOS/Linux/Windows).
        home / "Documents" / "KiCad" / "9.0" / "3rdparty" / "plugins" / "com_github_hulryung_lcsc_manager",
        home / ".local" / "share" / "kicad" / "9.0" / "3rdparty" / "plugins" / "com_github_hulryung_lcsc_manager",
    ]
    for c in candidates:
        if (c / "plugins" / "lcsc_manager" / "__init__.py").exists():
            return c / "plugins"
        # Allow pointing directly at the `plugins` dir or a PCM layout.
        if (c / "lcsc_manager" / "__init__.py").exists():
            return c
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="KiCad project file or directory")
    ap.add_argument("--lcsc", nargs="+", required=True, help="LCSC id(s), e.g. C25804")
    ap.add_argument("--symbol", action="store_true")
    ap.add_argument("--footprint", action="store_true")
    ap.add_argument("--3d", dest="model_3d", action="store_true")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--manager-path", default=None)
    args = ap.parse_args()

    # Keep stdout clean for the JSON result; route all logging to stderr and
    # quiet the engine's chatty INFO/DEBUG output.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    logging.getLogger("lcsc_manager").setLevel(logging.WARNING)
    for name in list(logging.root.manager.loggerDict):  # type: ignore[attr-defined]
        if name.startswith("lcsc_manager") or name in {"symbol_converter", "footprint_converter", "model_3d_converter", "library_manager"}:
            logging.getLogger(name).setLevel(logging.WARNING)

    manager = find_manager(args.manager_path)
    if manager is None:
        print(
            MARKER
            + json.dumps(
                {
                    "ok": False,
                    "error": "kicad-lcsc-manager not found. Install it (see "
                    "https://github.com/hulryung/kicad-lcsc-manager) or set "
                    "KICAD_LCSC_MANAGER to its directory.",
                }
            )
        )
        return 2
    sys.path.insert(0, str(manager))

    try:
        from lcsc_manager.api.lcsc_api import LCSCAPIClient
        from lcsc_manager.library.library_manager import LibraryManager
    except Exception as e:  # noqa: BLE001
        print(MARKER + json.dumps({"ok": False, "error": f"failed to load engine: {e}"}))
        return 2

    project = Path(args.project).expanduser().resolve()
    if project.is_dir():
        pros = list(project.glob("*.kicad_pro"))
        project = pros[0] if pros else project / "project.kicad_pro"

    want_all = not (args.symbol or args.footprint or args.model_3d)
    do_symbol = want_all or args.symbol
    do_footprint = want_all or args.footprint
    do_3d = want_all or args.model_3d

    api = LCSCAPIClient()
    lm = LibraryManager(project)

    results = []
    for raw in args.lcsc:
        lcsc = raw.strip().upper()
        if lcsc and lcsc[0].isdigit():
            lcsc = "C" + lcsc
        entry = {"lcsc": lcsc, "success": False}
        try:
            info = api.search_component(lcsc)
            if not info or not info.get("easyeda_data"):
                entry["error"] = "No symbol/footprint in EasyEDA's library for this part."
                results.append(entry)
                continue
            res = lm.import_component(
                easyeda_data=info["easyeda_data"],
                component_info=info,
                import_symbol=do_symbol,
                import_footprint=do_footprint,
                import_3d=do_3d,
            )
            entry["success"] = bool(res.get("success", True)) and not res.get("errors")
            entry["symbol"] = _stringify(res.get("symbol"))
            entry["footprint"] = _stringify(res.get("footprint"))
            entry["model_3d"] = _stringify(res.get("model_3d"))
            if res.get("errors"):
                entry["error"] = "; ".join(str(x) for x in res["errors"])
            # Useful metadata the engine already fetched.
            entry["mfr"] = info.get("mfr") or info.get("manufacturer_part")
            entry["stock"] = info.get("stock")
        except Exception as e:  # noqa: BLE001 — one bad part must not abort the batch
            entry["error"] = f"{type(e).__name__}: {e}"
        results.append(entry)

    try:
        lib_info = lm.get_library_info()
    except Exception:  # noqa: BLE001
        lib_info = {}

    print(
        MARKER
        + json.dumps(
            {
                "ok": any(r["success"] for r in results),
                "project": str(project),
                "library": _jsonable(lib_info),
                "results": results,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _stringify(v):
    if v is None:
        return None
    if isinstance(v, dict):
        return {k: str(x) for k, x in v.items()}
    return str(v)


def _jsonable(v):
    try:
        json.dumps(v)
        return v
    except TypeError:
        return {k: str(x) for k, x in (v or {}).items()}


if __name__ == "__main__":
    sys.exit(main())
