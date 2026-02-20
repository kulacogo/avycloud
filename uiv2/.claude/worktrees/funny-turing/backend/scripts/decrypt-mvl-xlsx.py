#!/usr/bin/env python3
"""
Decrypt the password-protected eBay MVL workbook (DE_MVL_2025_10.xlsx).

This keeps the password OUT of the repo. Provide it via env:
  MVL_PASSWORD="..." python3 backend/scripts/decrypt-mvl-xlsx.py
"""

from __future__ import annotations

import os
from pathlib import Path

import msoffcrypto


ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "DE_MVL_2025_10.xlsx"
OUT = ROOT / "exports" / "DE_MVL_2025_10.decrypted.xlsx"


def main() -> None:
    password = os.environ.get("MVL_PASSWORD", "")
    if not password:
        raise SystemExit("MVL_PASSWORD env missing")

    if not SRC.exists():
        raise SystemExit(f"Missing source file: {SRC}")

    OUT.parent.mkdir(parents=True, exist_ok=True)

    with SRC.open("rb") as f:
        office = msoffcrypto.OfficeFile(f)
        office.load_key(password=password)
        with OUT.open("wb") as of:
            office.decrypt(of)

    print("decrypted ->", OUT)
    print("size_bytes ->", OUT.stat().st_size)


if __name__ == "__main__":
    main()

