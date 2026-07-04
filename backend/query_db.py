import sqlite3
from app.db import get_db

conn = get_db()
doc_id = 4
cursor = conn.cursor()

# Get sessions
sessions = cursor.execute('SELECT id, name FROM tags WHERE document_id = ? AND tag_kind = "session" ORDER BY name', (doc_id,)).fetchall()
print(f"Total sessions: {len(sessions)}")
sess = sessions[0]
print(f'Session: {sess["name"]}')

portions = cursor.execute('''
    SELECT p.id, p.start_offset, p.end_offset, p.position 
    FROM text_portions p
    WHERE p.session_tag_id = ?
    ORDER BY p.position
''', (sess["id"],)).fetchall()

for p in portions[:2]:
    text = cursor.execute('SELECT raw_text FROM documents WHERE id = ?', (doc_id,)).fetchone()["raw_text"]
    print(f'  Portion {p["position"]}: {text[p["start_offset"]:p["end_offset"]][:50]}...')
    
    segments = cursor.execute('''
        SELECT s.id, s.seg_id, s.text 
        FROM portion_segments ps 
        JOIN srt_segments s ON ps.srt_segment_id = s.id 
        WHERE ps.portion_id = ? ORDER BY s.seg_id
    ''', (p["id"],)).fetchall()
    
    for s in segments[:2]:
        print(f'    Seg {s["seg_id"]}: {s["text"][:50]}...')
        
        # Check transcript spans for this segment
        spans = cursor.execute('''
            SELECT ts.start_offset, ts.end_offset, t.name
            FROM transcript_spans ts
            JOIN tags t ON ts.tag_id = t.id
            WHERE ts.srt_segment_id = ?
        ''', (s["id"],)).fetchall()
        for span in spans:
            print(f'      Span: {span["name"]} ({span["start_offset"]}-{span["end_offset"]}) -> {s["text"][span["start_offset"]:span["end_offset"]]}')

conn.close()
