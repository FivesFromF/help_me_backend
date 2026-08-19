#!/usr/bin/env python3
"""
process_images_to_json.py

Standalone tool to:
1. Extract 512-d face embeddings from real images in `test-images/`.
2. Store the vectors into local file database `test-images/output/database-temp.json`.
3. Optionally query/match a face image against stored embeddings in `database-temp.json`.

Usage:
  # 1. Process all images in test/ai-test/test-images/ and save to database-temp.json:
  python test/ai-test/process_images_to_json.py

  # 2. Process a specific image and add/update it in database-temp.json:
  python test/ai-test/process_images_to_json.py --image test/ai-test/test-images/my_photo.jpg

  # 3. Search a face image against stored vectors in database-temp.json:
  python test/ai-test/process_images_to_json.py --search test/ai-test/test-images/query.jpg
"""

import os
import sys
import glob
import json
import time
import argparse
import numpy as np
import cv2

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Add AI server directory to Python path
AI_SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../src/services/ai-server"))
if AI_SERVER_DIR not in sys.path:
    sys.path.insert(0, AI_SERVER_DIR)

from regconition_original import FaceProcessor

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
TEST_IMAGES_DIR = os.path.join(BASE_DIR, "test-images")
INPUT_DIR = os.path.join(TEST_IMAGES_DIR, "input") if os.path.exists(os.path.join(TEST_IMAGES_DIR, "input")) else TEST_IMAGES_DIR
OUTPUT_DIR = os.path.join(TEST_IMAGES_DIR, "output")
DB_JSON_PATH = os.path.join(OUTPUT_DIR, "database-temp.json")

def load_db(db_path: str = DB_JSON_PATH) -> dict:
    if os.path.exists(db_path):
        try:
            with open(db_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"updated_at": None, "total_records": 0, "records": []}

def save_db(data: dict, db_path: str = DB_JSON_PATH):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    data["total_records"] = len(data.get("records", []))
    with open(db_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def process_single_image(processor: FaceProcessor, image_path: str):
    """Loads image, runs validation + anti-spoofing, extracts 512-d embedding."""
    if not os.path.exists(image_path):
        return False, f"File not found: {image_path}", None

    img = cv2.imread(image_path)
    if img is None:
        return False, f"Failed to decode image: {image_path}", None

    h, w, c = img.shape
    success, result = processor.process_image(img)

    if not success:
        return False, result, None

    embedding = result # 512 floats
    l2_norm = float(np.linalg.norm(embedding))

    record = {
        "id": os.path.splitext(os.path.basename(image_path))[0],
        "filename": os.path.basename(image_path),
        "image_path": os.path.abspath(image_path),
        "dimensions": {"width": w, "height": h, "channels": c},
        "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "vector_length": len(embedding),
        "l2_norm": round(l2_norm, 6),
        "embedding": [round(float(v), 8) for v in embedding],
    }
    return True, "Success", record

def run_batch_indexing(image_path_or_none: str = None):
    print("=" * 65)
    print("📁 HelpMe AI: Extracting Embeddings to Local database-temp.json")
    print("=" * 65)

    processor = FaceProcessor()
    db = load_db()
    existing_records = {r["id"]: r for r in db.get("records", [])}

    if image_path_or_none:
        images_to_process = [image_path_or_none]
    else:
        # Scan input directory for images
        patterns = ["*.jpg", "*.jpeg", "*.png", "*.JPG", "*.PNG"]
        images_to_process = []
        for p in patterns:
            images_to_process.extend(glob.glob(os.path.join(INPUT_DIR, p)))

    if not images_to_process:
        print(f"\n⚠️  No images found in: {INPUT_DIR}")
        print("   Drop .jpg/.png face photos into `test/ai-test/test-images/input/` to extract embeddings.")
        return

    print(f"\n🔍 Found {len(images_to_process)} image(s) to process:\n")
    processed_count = 0

    for img_path in images_to_process:
        filename = os.path.basename(img_path)
        print(f"👉 Processing: {filename}...")
        success, msg, record = process_single_image(processor, img_path)

        if success and record:
            existing_records[record["id"]] = record
            processed_count += 1
            print(f"   ✅ Extracted 512-d embedding (L2 norm: {record['l2_norm']})")
        else:
            print(f"   ❌ Rejected: {msg}")

    # Save to database-temp.json
    db["records"] = list(existing_records.values())
    save_db(db)

    print("\n" + "-" * 65)
    print(f"💾 Saved to: {DB_JSON_PATH}")
    print(f"📊 Total Records in database-temp.json: {len(db['records'])} (Updated: {processed_count})")
    print("=" * 65 + "\n")

def find_best_match(query_image_path: str, db_path: str = DB_JSON_PATH):
    """
    Programmatic helper:
    Takes a query face image and returns the best matching candidate's
    record, avatar path, and similarity distance from database-temp.json.
    """
    db = load_db(db_path)
    records = db.get("records", [])
    if not records:
        return None, "Database is empty"

    processor = FaceProcessor()
    success, msg, query_rec = process_single_image(processor, query_image_path)
    if not success or not query_rec:
        return None, msg

    query_vec = np.array(query_rec["embedding"], dtype=np.float32)
    ranked = []
    for r in records:
        stored_vec = np.array(r["embedding"], dtype=np.float32)
        dist = float(1.0 - np.dot(query_vec, stored_vec))
        ranked.append({
            "id": r["id"],
            "filename": r["filename"],
            "avatar_path": r.get("image_path", ""),
            "distance": round(dist, 6),
            "confidence": round((1.0 - dist) * 100, 2),
            "is_match": dist < 0.35,
        })

    ranked.sort(key=lambda x: x["distance"])
    return ranked, "Success"

def run_search(query_image_path: str):
    print("=" * 65)
    print("🔍 HelpMe AI: Search Image against database-temp.json")
    print("=" * 65)

    db = load_db()
    records = db.get("records", [])
    if not records:
        print(f"❌ Error: database-temp.json is empty. Index images first.")
        return

    print(f"📂 Query Image: {query_image_path}")
    processor = FaceProcessor()
    success, msg, record = process_single_image(processor, query_image_path)

    if not success or not record:
        print(f"❌ Query face rejected: {msg}")
        return

    query_vec = np.array(record["embedding"], dtype=np.float32)

    print(f"\n📊 Comparing against {len(records)} stored vectors in database-temp.json:\n")
    results = []

    for r in records:
        stored_vec = np.array(r["embedding"], dtype=np.float32)
        # Cosine distance = 1 - dot_product (for normalized vectors)
        cosine_dist = float(1.0 - np.dot(query_vec, stored_vec))
        results.append({
            "id": r["id"],
            "filename": r["filename"],
            "image_path": r.get("image_path", ""),
            "distance": cosine_dist,
            "dimensions": r.get("dimensions", {}),
            "l2_norm": r.get("l2_norm", 1.0),
        })

    # Sort by closest distance and take top 3
    results.sort(key=lambda x: x["distance"])
    top_3 = results[:3]

    print(f"🎯 Top {len(top_3)} Best Matching Candidates (Distance Threshold < 0.35):\n")
    for idx, match in enumerate(top_3, 1):
        dist = match["distance"]
        if dist < 0.001:
            status = "🎯 Exact Match (Self)"
        elif dist < 0.35:
            status = "✅ Match Found (<0.35)"
        else:
            status = "⚠️ Weak Match (>0.35)"

        print(f"   [{idx}] ID        : {match['id']}")
        print(f"       Distance  : {dist:.6f}  [{status}]")
        print(f"       Avatar File: {match['filename']}")
        print(f"       Avatar Path: {match['image_path']}")
        print()

    # Highlight and save the Best Match Avatar
    if top_3:
        best_match = top_3[0]
        print("-" * 65)
        print("🏆 BEST MATCH AVATAR FOUND:")
        print(f"   • Citizen ID  : {best_match['id']}")
        print(f"   • Confidence  : {(1.0 - best_match['distance']) * 100:.2f}% (Distance: {best_match['distance']:.4f})")
        print(f"   • Avatar File : {best_match['filename']}")
        print(f"   • Avatar Path : {best_match['image_path']}")
        print("-" * 65)

    print("\n" + "=" * 65 + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract 512-d embeddings to local database-temp.json")
    parser.add_argument("--image", "-i", default=None, help="Path to single image file to process")
    parser.add_argument("--search", "-s", default=None, help="Path to query image to match against database-temp.json")

    args = parser.parse_args()

    if args.search:
        run_search(args.search)
    else:
        run_batch_indexing(args.image)
