#!/usr/bin/env python3
import os
import re

SECRET_FILE = "/etc/qiuqiu/chat-frontend.env"
SECRET_NAME = "DWELL_FRONTEND_DELIVERY_SECRET"
NODE = "/usr/bin/node"
HELPER = "/root/.local/lib/qiuqiu-frontend-message/frontend-message-mcp.mjs"
VALID_SECRET = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


def read_secret(path=SECRET_FILE):
    with open(path, encoding="utf-8") as handle:
        for source_line in handle:
            line = source_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            if key.strip() != SECRET_NAME:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if VALID_SECRET.fullmatch(value) and value != "${DWELL_FRONTEND_DELIVERY_SECRET}":
                return value
            break
    raise RuntimeError("frontend delivery credential unavailable")


def main():
    try:
        secret = read_secret()
    except (OSError, RuntimeError):
        os.write(2, b"frontend helper credential unavailable\n")
        raise SystemExit(78)
    environment = os.environ.copy()
    environment[SECRET_NAME] = secret
    os.execve(NODE, [NODE, HELPER], environment)


if __name__ == "__main__":
    main()
