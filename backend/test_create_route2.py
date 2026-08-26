import sys
sys.path.insert(0, r'C:\Users\ACER\OneDrive\Desktop\diensh\minor-project-BE\backend')

from sqlalchemy import create_engine, text

engine = create_engine('postgresql+psycopg2://ktm_bus:ktm_bus@localhost:5433/ktm_bus')
conn = engine.connect()

# Test: Try inserting a new route
print('=== Insert test ===')
new_route_id = 'R3351752'  # Next after the max seen earlier
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
    
    # Select the created route
    print('\n=== Select test ===')
    row = conn.execute(
        text("SELECT route_id, route_name, short_name, vehicle_type, total_stops, approx_distance_km, start_stop_id, end_stop_id FROM routes WHERE route_id = :route_id AND status = 'active'"),
        {'route_id': new_route_id}
    ).mappings().first()
    print(f'Selected row: {dict(row)}')
    
    # Test creating another route
    print('\n=== Second insert test ===')
    result2 = conn.execute(text(
        "INSERT INTO routes (route_id, route_name, vehicle_type, total_stops, start_stop_id, end_stop_id, status) "
        "VALUES (:route_id, :route_name, :vehicle_type, 0, NULL, NULL, 'active') "
        "RETURNING route_id, route_name, short_name, vehicle_type, total_stops, approx_distance_km, start_stop_id, end_stop_id"
    ), {
        'route_id': 'R3351753',
        'route_name': 'Another Route',
        'vehicle_type': 'bus',
    })
    new_row2 = result2.fetchone()
    print(f'Inserted row: {new_row2}')
    conn.commit()
    
    # List all routes
    print('\n=== All active routes ===')
    rows = conn.execute(text("SELECT route_id, route_name FROM routes WHERE status = 'active' ORDER BY route_name")).fetchall()
    for r in rows:
        print(f'  {r[0]}: {r[1]}')
        
except Exception as e:
    print(f'Error: {e}')
    import traceback
    traceback.print_exc()
finally:
    conn.close()