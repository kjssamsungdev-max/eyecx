#!/usr/bin/env python3
"""
Generate daily subscription lists by tier.
Outputs JSON files for API delivery.
"""

import os
import json
import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = os.getenv('DB_PATH', './eyecx.db')
OUTPUT_DIR = './subscription_lists'

TIERS = {
    'premium': {'limit': 500, 'min_score': 70, 'price': 99},
    'standard': {'limit': 200, 'min_score': 55, 'price': 49},
    'basic': {'limit': 50, 'min_score': 40, 'price': 19}
}


def generate_lists():
    """Generate subscription lists for each tier."""
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    timestamp = datetime.now().strftime('%Y%m%d')
    
    for tier_name, config in TIERS.items():
        cursor = conn.execute("""
            SELECT domain, tld, potential_score, tier, estimated_flip_value,
                   page_rank, wayback_snapshots, estimated_age_years, backlinks
            FROM domains
            WHERE potential_score >= ?
            AND availability_status IN ('available', 'unknown')
            ORDER BY potential_score DESC, first_seen DESC
            LIMIT ?
        """, (config['min_score'], config['limit']))
        
        domains = [dict(row) for row in cursor.fetchall()]
        
        output = {
            'tier': tier_name,
            'generated_at': datetime.now().isoformat(),
            'count': len(domains),
            'min_score': config['min_score'],
            'domains': domains
        }
        
        filepath = os.path.join(OUTPUT_DIR, f"{tier_name}_{timestamp}.json")
        with open(filepath, 'w') as f:
            json.dump(output, f, indent=2)
        
        print(f"Generated {tier_name}: {len(domains)} domains -> {filepath}")
    
    conn.close()


if __name__ == "__main__":
    generate_lists()
