import os
import cv2
import numpy as np
import torch
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException
from regconition_original import FaceProcessor
from worker import run_sqs_worker

# Initialize global processor
processor = FaceProcessor()
worker_stop_event = threading.Event()
worker_thread: threading.Thread = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global worker_thread
    # Start SQS Background Worker
    worker_thread = threading.Thread(target=run_sqs_worker, args=(processor, worker_stop_event), daemon=True)
    worker_thread.start()
    yield
    # Graceful Shutdown
    worker_stop_event.set()
    if worker_thread and worker_thread.is_alive():
        worker_thread.join(timeout=5)

app = FastAPI(title="HelpMe AI Server", lifespan=lifespan)

@app.post("/extract-embedding")
async def extract_embedding(image: UploadFile = File(...)):
    """
    Extracts a 512-dimensional face embedding from an uploaded image.
    Uses the logic ported from the AI Face POC.
    """
    # Read bytes from the uploaded file
    contents = await image.read()
    
    # Convert bytes to numpy array
    nparr = np.frombuffer(contents, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image format or corrupted file")

    try:
        # Run the original process_image logic from POC
        # result is either an error string or a list of floats
        success, result = processor.process_image(img)
        
        if success:
            return {
                "success": True,
                "message": "AI Processing Successful",
                "embedding": result # 512 floats
            }
        else:
            raise HTTPException(status_code=400, detail=result)
    except HTTPException:
        # Re-raise HTTPException so FastAPI can handle it with the correct status code
        raise
    except Exception as e:
        # Unexpected server errors should return 500
        raise HTTPException(status_code=500, detail=f"Internal AI Server Error: {str(e)}")

@app.get("/health")
def health():
    """Health check endpoint for ECS and ALB."""
    return {"status": "alive", "device": "cuda" if torch.cuda.is_available() else "cpu"}

if __name__ == "__main__":
    import uvicorn
    # In production, uvicorn is typically called from the command line
    uvicorn.run(app, host="0.0.0.0", port=8000)
