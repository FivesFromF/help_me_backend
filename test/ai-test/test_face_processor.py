import pytest
import numpy as np
import torch
import sys
import os

# Add AI server directory to Python path
AI_SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../src/services/ai-server"))
if AI_SERVER_DIR not in sys.path:
    sys.path.insert(0, AI_SERVER_DIR)

from regconition_original import FaceProcessor, CONFIG

@pytest.fixture(scope="module")
def processor():
    """Loads FaceProcessor model once for the test module."""
    return FaceProcessor()

class TestFaceProcessor:
    def test_model_initialization(self, processor):
        """Verify MediaPipe detector and EdgeFace backbone are initialized properly."""
        assert processor.detector is not None
        assert processor.face_engine is not None
        assert processor.device in [torch.device("cpu"), torch.device("cuda")]

    def test_process_none_image(self, processor):
        """Verify handling when None is passed."""
        success, message = processor.process_image(None)
        assert success is False
        assert "No image data received" in message

    def test_process_blank_image(self, processor):
        """Verify that an all-black image is rejected because no face is detected."""
        blank_image = np.zeros((480, 640, 3), dtype=np.uint8)
        success, message = processor.process_image(blank_image)
        assert success is False
        assert "No face detected" in message

    def test_process_noise_image(self, processor):
        """Verify that a random noise image is rejected by MediaPipe."""
        noise_image = np.random.randint(0, 256, (480, 640, 3), dtype=np.uint8)
        success, message = processor.process_image(noise_image)
        assert success is False
        assert "No face detected" in message

    def test_extract_embedding_dimension_and_l2_norm(self, processor):
        """Verify that _extract_embedding produces a 512-dimension L2-normalized vector."""
        dummy_face_crop = np.random.randint(50, 200, (112, 112, 3), dtype=np.uint8)
        embedding = processor._extract_embedding(dummy_face_crop)
        
        assert isinstance(embedding, list)
        assert len(embedding) == 512
        assert all(isinstance(x, float) for x in embedding)
        
        # Verify L2 normalization: norm = sqrt(sum(x_i^2)) should equal 1.0
        vec = np.array(embedding, dtype=np.float32)
        norm = np.linalg.norm(vec)
        assert np.isclose(norm, 1.0, atol=1e-3)
