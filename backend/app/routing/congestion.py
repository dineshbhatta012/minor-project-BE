import csv
from pathlib import Path
from threading import Lock
from collections import defaultdict

_cache_lock = Lock()
_cached_congestion: dict[str, dict[str, float]] | None = None


def load_congestion() -> dict[str, dict[str, float]]:
    """
    Reads stops_with_congestion_final.csv once and returns a mapping:
    {stop_id: {"score": float, "loss": float}}
    """
    repo_root = Path(__file__).resolve().parents[3]
    csv_path = repo_root / "stops_with_congestion_final.csv"

    data: dict[str, dict[str, float]] = defaultdict(lambda: {"score": 0.0, "loss": 0.0})

    if not csv_path.exists():
        return data

    with open(csv_path, mode="r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            stop_id = row.get("stop_id")
            if not stop_id:
                continue
            try:
                score = float(row.get("congestion_score") or 0.0)
            except (ValueError, TypeError):
                score = 0.0
            try:
                loss = float(row.get("congestion_loss") or 0.0)
            except (ValueError, TypeError):
                loss = 0.0

            data[stop_id] = {"score": score, "loss": loss}

    return data


def get_congestion() -> dict[str, dict[str, float]]:
    """
    Thread-safe cached access to congestion data.
    """
    global _cached_congestion
    with _cache_lock:
        if _cached_congestion is None:
            _cached_congestion = load_congestion()
        return _cached_congestion
