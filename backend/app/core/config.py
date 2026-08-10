from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg2://ktm_bus:ktm_bus@localhost:5432/ktm_bus"
    cors_origins: list[str] = ["http://localhost:3000"]

    # Interchange penalty added when a path switches from one route to
    # another, expressed in "equivalent km" added to the Dijkstra weight.
    #
    # 5.0 was chosen empirically, not guessed: against the real 87-route
    # dataset, a low penalty (1.2) let Dijkstra pick a 4-transfer path over
    # a plain single-route ride between the same two stops, because
    # Kathmandu's routes overlap enough that hopping between them can shave
    # a little real distance even after a small penalty. 5.0 was the point
    # where the direct route won out in that test case. Re-test with your
    # own real query pairs and raise it further if you still see
    # multi-transfer results where a direct route obviously exists — the
    # /route/search endpoint logs a warning exactly when this happens.
    transfer_penalty_km: float = 5.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
