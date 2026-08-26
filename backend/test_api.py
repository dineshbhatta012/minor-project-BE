import sys
sys.path.insert(0, r'C:\Users\ACER\OneDrive\Desktop\diensh\minor-project-BE\backend')

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

# Test creating a route
print('=== Test: Create Route ===')
resp = client.post("/routes", json={"route_name": "Test Route via API"})
print(f'Status: {resp.status_code}')
print(f'Response: {resp.json()}')

# Test creating another route
print('\n=== Test: Create Another Route ===')
resp2 = client.post("/routes", json={"route_name": "Another Route"})
print(f'Status: {resp2.status_code}')
print(f'Response: {resp2.json()}')

# Test creating route with empty name
print('\n=== Test: Create Route with Empty Name ===')
resp3 = client.post("/routes", json={"route_name": ""})
print(f'Status: {resp3.status_code}')
print(f'Response: {resp3.json()}')

# Test creating route with whitespace-only name
print('\n=== Test: Create Route with Whitespace Name ===')
resp4 = client.post("/routes", json={"route_name": "   "})
print(f'Status: {resp4.status_code}')
print(f'Response: {resp4.json()}')