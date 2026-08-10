from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

settings = get_settings()

# Raw SQLAlchemy Core is used deliberately instead of the ORM: several
# columns (geom GEOGRAPHY, distance_range NUMRANGE, TEXT[] arrays) don't map
# cleanly onto ORM column types, and every query this API needs is a plain
# read, so text()-based queries via Session.execute keep things simple and
# match the schema exactly.
engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
