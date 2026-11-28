"""Allow `python3 -m lumen_linux` execution."""

from .app import main

if __name__ == "__main__":
    raise SystemExit(main())
