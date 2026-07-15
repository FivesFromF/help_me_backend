import os
import cv2
import numpy as np
import torch
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from regconition_original import FaceProcessor

app = FastAPI(title="HelpMe AI Service")

# --- Security Middleware ---
AI_SECRET = os.getenv("AI_INTERNAL_SECRET", "changeme")

@app.middleware("http")
async def verify_secret(request: Request, call_next):
    # Allow health check without secret
    if request.url.path == "/health":
        return await call_next(request)
        
    secret = request.headers.get("X-HelpMe-Secret")
    if secret != AI_SECRET:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=403, content={"detail": "Forbidden: Invalid Secret Key"})
    
    return await call_next(request)

from pydantic import BaseModel
import base64

class ImagePayload(BaseModel):
    image: str

# Initialize global processor
processor = FaceProcessor()

@app.post("/extract")
async def extract_embedding(payload: ImagePayload):
    """
    Extracts a 512-dimensional face embedding from a base64 encoded image.
    Uses the logic ported from the AI Face POC.
    """
    try:
        # Decode base64 to bytes
        contents = base64.b64decode(payload.image)
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
        raise HTTPException(status_code=500, detail=f"Internal AI Service Error: {str(e)}")

@app.get("/health")
def health():
    """Health check endpoint for ECS."""
    return {"status": "alive", "device": "cuda" if torch.cuda.is_available() else "cpu"}

if __name__ == "__main__":
    import uvicorn
    # In production, uvicorn is typically called from the command line
    uvicorn.run(app, host="0.0.0.0", port=8000)
