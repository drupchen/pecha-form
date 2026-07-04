"""§13: test_source_endpoint — upload a file, then GET /export/source
and assert bytes returned equal bytes uploaded.

Since this requires running the FastAPI app, we use TestClient.
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

import tempfile
import shutil
from fastapi.testclient import TestClient

# Set up a temporary DB for testing
TEST_DB = os.path.join(os.path.dirname(__file__), "test_sapche.db")

def setup_module():
    """Override DB path before importing app."""
    import db
    db.DB_PATH = TEST_DB

def teardown_module():
    """Clean up test DB."""
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)

def test_source_endpoint_roundtrip():
    import db
    db.DB_PATH = TEST_DB
    
    # Must import after setting DB_PATH
    from main import app
    db.init_db()
    
    client = TestClient(app)
    
    # The original bytes — include unusual whitespace, newlines, Tibetan text
    original_text = "  སྐྱབས་འགྲོ།\n\nབྱང་ཆུབ་སེམས་བསྐྱེད།  \n"
    original_bytes = original_text.encode("utf-8")
    
    # Upload
    response = client.post(
        "/api/texts",
        files={"file": ("test.txt", original_bytes, "text/plain")},
    )
    assert response.status_code == 200, response.text
    doc_id = response.json()["id"]
    
    # GET /export/source and check byte-for-byte equality
    response = client.get(f"/api/texts/{doc_id}/export/source")
    assert response.status_code == 200
    assert response.text == original_text, (
        f"Source export does not match upload.\n"
        f"Expected: {repr(original_text)}\n"
        f"Got:      {repr(response.text)}"
    )
