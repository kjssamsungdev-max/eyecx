#!/usr/bin/env python3
"""
Upload scan results to Cloudflare D1.
Used by GitHub Actions after daily scan.
"""

import os
import sys
import csv
import json
import asyncio
import aiohttp
from typing import List, Dict

CLOUDFLARE_API_TOKEN = os.getenv('CLOUDFLARE_API_TOKEN')
CLOUDFLARE_ACCOUNT_ID = os.getenv('CLOUDFLARE_ACCOUNT_ID')
D1_DATABASE_ID = os.getenv('D1_DATABASE_ID')

API_BASE = f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}"


async def upload_batch(session: aiohttp.ClientSession, rows: List[Dict]):
    """Upload a batch of rows via D1 API."""
    
    # Build SQL insert
    if not rows:
        return
    
    fields = list(rows[0].keys())
    placeholders = ', '.join(['?' for _ in fields])
    
    sql = f"""
        INSERT OR REPLACE INTO domains ({', '.join(fields)})
        VALUES ({placeholders})
    """
    
    # D1 API expects array of parameter arrays
    params = [[row.get(f) for f in fields] for row in rows]
    
    payload = {
        "sql": sql,
        "params": params[0] if len(params) == 1 else None
    }
    
    # For batch, use multiple statements
    if len(params) > 1:
        statements = []
        for p in params:
            statements.append({"sql": sql, "params": p})
        payload = statements
    
    headers = {
        "Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}",
        "Content-Type": "application/json"
    }
    
    async with session.post(
        f"{API_BASE}/query",
        headers=headers,
        json=payload
    ) as resp:
        if resp.status != 200:
            print(f"Upload failed: {await resp.text()}")
        else:
            data = await resp.json()
            if data.get('success'):
                print(f"  Uploaded {len(rows)} rows")
            else:
                print(f"  Error: {data.get('errors')}")


async def main(csv_file: str):
    """Main upload function."""
    
    if not all([CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID]):
        print("Missing Cloudflare credentials in environment")
        sys.exit(1)
    
    # Read CSV
    rows = []
    with open(csv_file) as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Clean up types
            clean_row = {}
            for k, v in row.items():
                if v == '' or v is None:
                    clean_row[k] = None
                elif k in ['potential_score', 'wayback_snapshots', 'backlinks', 'majestic_rank', 'tranco_rank']:
                    clean_row[k] = int(v) if v else None
                elif k in ['page_rank', 'estimated_age_years', 'estimated_flip_value']:
                    clean_row[k] = float(v) if v else None
                else:
                    clean_row[k] = v
            rows.append(clean_row)
    
    print(f"Uploading {len(rows)} domains from {csv_file}")
    
    # Upload in batches
    batch_size = 100
    async with aiohttp.ClientSession() as session:
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i+batch_size]
            await upload_batch(session, batch)
            await asyncio.sleep(0.5)  # Rate limit
    
    print("Upload complete")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python upload_to_d1.py <csv_file>")
        sys.exit(1)
    
    asyncio.run(main(sys.argv[1]))
