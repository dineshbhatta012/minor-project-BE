import sys
sys.path.insert(0, r'C:\Users\ACER\OneDrive\Desktop\diensh\minor-project-BE\backend')

from sqlalchemy import create_engine, text

engine = create_engine('postgresql+psycopg2://ktm_bus:ktm_bus@localhost:5433/ktm_bus')
conn = engine.connect()

# Test 1: Check existing routes
print('=== Existing routes ===')
rows = conn.execute(text("SELECT route_id, route_name FROM routes WHERE status = 'active'")).fetchall()
for r in rows:
    print(f'  {r[0]}: {r[1]}')

# Test 2: Test the ID generation logic
print('\n=== ID generation test ===')
max_row = conn.execute(text(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(route_id FROM 2) AS INTEGER)), 0) AS max_id "
    "FROM routes WHERE route_id ~ '^R[0-9]+$'"
)).mappings().first()
print(f'max_row: {max_row}')
new_route_id = f'R{int(max_row["max_id"]) + 1}'
print(f'new_route_id: {new_route_id}')

# Test 3: Try inserting a new route
print('\n=== Insert test ===')
try:
    result = conn.execute(text(
        "INSERT INTO routes (route_id, route_name, vehicle_type, total_stops, start_stop_id, end_stop_id, status) "
        "VALUES (:route_id, :route_name, :vehicle_type, 0, NULL, NULL, 'active') "
        "RETURNING route_id, route_name, short_name, vehicle_type, total_stops, approx_distance_km, start_stop_id, end_stop_id"
    ), {
        'route_id': new_route_id,
        'route_name': 'Test Route',
        'vehicle_type': 'bus',
    })
    new_row = result.fetchone()
    print(f'Inserted row: {new_row}')
    conn.commit()
    
    # Test 4: Select the created route
    print('\n=== Select test ===')
    row = conn.execute(
        text("SELECT route_id, route_name, short_name, vehicle_type, total_stops, approx_distance_km, start_stop_id, end_stop_id FROM routes WHERE route_id = :route_id AND status = 'active'"),
        {'route_id': new_route_id}
    ).mappings().first()
    print(f'Selected row: {dict(row)}')
    
    # Test 5: Try creating another route
    print('\n=== Second insert test ===')
    result2 = conn.execute(text(
        "INSERT INTO routes (route_id, route_name, vehicle_type, total_stops, start_stop_id, end_stop_id, status) "
        "VALUES (:route_id, :route_name, :vehicle_type, 0, NULL, NULL, 'active') "
        "RETURNING route_id, route_name, short_name, vehicle_type, total_stops, approx_distance_km, start_stop_id, end_stop_id"
    ), {
        'route_id': 'R999',
        'route_name': 'Another Route',
        'vehicle_type': 'bus',
    })
    new_row2 = result2.fetchone()
    print(f'Inserted row: {new_row2}')
    conn.rollback()
    
except Exception as e:
    print(f'Error: {e}')
    import traceback
    traceback.print_exc()
finally:
    conn.close()