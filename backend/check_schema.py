import sys
sys.path.insert(0, r'C:\Users\ACER\OneDrive\Desktop\diensh\minor-project-BE\backend')
from sqlalchemy import create_engine, text

engine = create_engine('postgresql+psycopg2://ktm_bus:ktm_bus@localhost:5433/ktm_bus')
conn = engine.connect()

# Check the actual schema for start_stop_id and end_stop_id
print('=== Checking routes table columns ===')
cols = conn.execute(text("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'routes' ORDER BY ordinal_position")).fetchall()
for c in cols:
    print(f'  {c[0]}: nullable={c[1]}')

conn.close()