"""Small standard-library example for a read-only device gateway.

The script sends observations to PowerPilot's scoped HTTP endpoint. It is
intentionally protocol-neutral: a field gateway or Node-RED flow should turn
Modbus/OPC UA/MQTT readings into the JSON shape before invoking it. The device
token is read from an environment variable and is never printed.

Example:
  $env:POWERPILOT_DEVICE_TOKEN = 'ppt_...'
  python integrations/gateway_push.py --device METER-01 --points points.json

The input file is a JSON array or {"points": [...]} with timezone-aware ISO
timestamps. This client does not control a PLC, PCS, BMS, or production line.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser(description="Send read-only telemetry for one registered device")
    parser.add_argument("--device", required=True, help="registered device ID")
    parser.add_argument("--points", required=True, help="JSON file containing an array of observations")
    parser.add_argument("--source", default="edge-gateway", help="source label retained with the batch")
    parser.add_argument("--base-url", default=os.environ.get("POWERPILOT_BASE_URL", "http://127.0.0.1:8080"))
    args = parser.parse_args()
    token = os.environ.get("POWERPILOT_DEVICE_TOKEN", "").strip()
    if not token:
        parser.error("set POWERPILOT_DEVICE_TOKEN in the gateway environment")
    try:
        with open(args.points, "r", encoding="utf-8") as handle:
            body = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cannot read points file: {exc}", file=sys.stderr)
        return 2
    points = body.get("points") if isinstance(body, dict) else body
    if not isinstance(points, list):
        print("points file must be a JSON array or an object with a points array", file=sys.stderr)
        return 2
    payload = json.dumps({"deviceId": args.device, "source": args.source, "points": points}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        args.base_url.rstrip("/") + "/api/gateway/telemetry",
        data=payload,
        method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"gateway rejected batch ({exc.code}): {detail}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"gateway request failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": result.get("status"), "batchId": result.get("batchId"), "inserted": result.get("inserted")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
