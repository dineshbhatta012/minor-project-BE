import sys
sys.path.insert(0, r'C:\Users\ACER\OneDrive\Desktop\diensh\minor-project-BE\backend')
from sqlalchemy import create_engine, text

engine = create_engine('postgresql+psycopg2://ktm_bus:ktm_bus@localhost:5433/ktm_bus')
conn = engine.connect()

# Fix: Make start_stop_id and end_stop_id nullable
print('=== Altering routes table columns ===')
try:
    conn.execute(text("ALTER TABLE routes ALTER COLUMN start_stop_id DROP NOT NULL"))
    print('  start_stop_id: DROP NOT NULL - OK')
except Exception as e:
    print(f'  start_stop_id: ERROR - {e}')

try:
    conn.execute(text("ALTER TABLE routes ALTER COLUMN end_stop_id DROP NOT NULL"))
    print('  end_stop_id: DROP NOT NULL - OK')
except Exception as e:
    print(f'  end_stop_id: ERROR - {e}')

conn.commit()

# Verify the change
print('\n=== Verifying changes ===')
cols = conn.execute(text("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'routes' ORDER BY ordinal_position")).fetchall()
for c in cols:
    if c[0] in ('start_stop_id', 'end_stop_id'):
        print(f'  {c[0]}: nullable={c[1]}')

conn.close()
print('\nDone!')