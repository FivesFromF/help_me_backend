import os
import cv2
import numpy as np
import torch
from fastapi import FastAPI, UploadFile, File, HTTPException
from regconition_original import FaceProcessor

app = FastAPI(title="HelpMe AI Server")

# Initialize global processor
# This will load models into memory immediately on startup
processor = FaceProcessor()

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
            return {
                "success": False,
                "message": result, # e.g., "No face detected", "Face tilted"
                "embedding": []
            }
    except Exception as e:
        # Prevent server from crashing on unexpected errors
        return {
            "success": False,
            "message": f"Internal AI Server Error: {str(e)}",
            "embedding": []
        }

@app.get("/health")
def health():
    """Health check endpoint for ECS and ALB."""
    return {"status": "alive", "device": "cuda" if torch.cuda.is_available() else "cpu"}

if __name__ == "__main__":
    import uvicorn
    # In production, uvicorn is typically called from the command line
    uvicorn.run(app, host="0.0.0.0", port=8000)
